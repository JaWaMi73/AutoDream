#!/usr/bin/env node
/**
 * Guardian — PROTECT layer
 * PreToolUse Bash: secret scan (git commits) + danger scoring
 * PreToolUse WebFetch: domain guard (warns on Haiku-compressed domains)
 * Exit 0 = allow, Exit 2 = block
 */
"use strict";
const fs = require("fs");
const { execFileSync } = require("child_process");

const SECRET_PATTERNS = [
  { name: "Anthropic API Key", re: /sk-ant-api[0-9a-zA-Z\-_]{20,}/ },
  { name: "OpenAI API Key",    re: /sk-[a-zA-Z0-9]{40,}/ },
  { name: "AWS Access Key ID", re: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub PAT",        re: /gh[pso]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{80,}/ },
  { name: "Slack Token",       re: /xox[bpoas]-[a-zA-Z0-9\-]+/ },
  { name: "Stripe Live Key",   re: /sk_live_[a-zA-Z0-9]{24,}|rk_live_[a-zA-Z0-9]{24,}/ },
  { name: "Google API Key",    re: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: "Private Key Block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "JWT Token",         re: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/ },
  { name: "Generic api_key",   re: /api[_-]?key\s*[:=]\s*['"]?[a-zA-Z0-9\-_]{20,}['"]?/i },
  { name: "Generic secret",    re: /secret\s*[:=]\s*['"]?[a-zA-Z0-9\-_]{20,}['"]?/i },
];
const SKIP_PATH_RE = /node_modules|\.min\.(js|css)|\.map$|package-lock\.json|yarn\.lock|pnpm-lock\.yaml/;
const PLACEHOLDER_RE = /test[-_]?key|example[-_]?token|your[-_]?api|placeholder|dummy|fake_|xxx+|changeme/i;

const WARN_DOMAINS = ["shopify.dev", "partners.shopify.com", "help.shopify.com", "stripe.com/docs"];
const SAFE_DOMAINS = ["platform.claude.com", "react.dev", "nextjs.org", "developer.mozilla.org"];

const DANGER_PATTERNS = [
  [/\brm\b.*-[a-z]*r[a-z]*f|rm\b.*-[a-z]*f[a-z]*r|\brm\s+-rf\b/i, 5, "recursive force delete"],
  [/\brm\s+-f\b/i, 3, "force delete"],
  [/\bmkfs\b|\bformat\s/i, 8, "filesystem format"],
  [/>\s*\/dev\/(?!null)[a-z]/i, 7, "write to device"],
  [/git\s+push\s+.*--force|git\s+push\s+-f\b/i, 4, "git force push"],
  [/git\s+reset\s+--hard/i, 4, "git hard reset"],
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, 7, "SQL drop"],
  [/\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, 6, "SQL delete no WHERE"],
  [/\bTRUNCATE\b/i, 7, "SQL truncate"],
  [/\bsudo\b/i, 4, "sudo escalation"],
  [/~\/\.claude\/settings/i, 5, "Claude settings modification"],
  [/~\/\.ssh\//i, 4, "SSH directory access"],
  [/\bcurl\b.*\|\s*\bbash\b/i, 6, "curl pipe to bash"],
  [/\bwget\b.*\|\s*\bsh\b/i, 6, "wget pipe to shell"],
  [/\bbase64\s+-d\b.*\|\s*(bash|sh)/i, 5, "base64 decode to shell"],
];

function normPath(p) { return p.replace(/\\/g, "/").replace(/\/\/+/g, "/").replace(/\/+$/, ""); }

function dangerScore(command, cwd) {
  let score = 0;
  const reasons = [];
  for (const [re, pts, desc] of DANGER_PATTERNS) {
    if (re.test(command)) { score += pts; reasons.push(`${desc} (+${pts})`); }
  }
  const pipes = (command.match(/\|/g) || []).length;
  if (pipes > 3) { score += 2; reasons.push("long pipe chain (+2)"); }
  if (cwd && cwd.length > 4) {
    const ncwd = normPath(cwd);
    const absPaths = command.match(/(?:^|\s)([A-Za-z]:[\\\/][^\s]+|\/[^\s]+)/g) || [];
    for (const p of absPaths) {
      const t = normPath(p.trim());
      if (t === "/dev/null") continue;
      if (!t.startsWith(ncwd)) { score += 3; reasons.push("targets outside CWD (+3)"); break; }
    }
  }
  return { score: Math.min(score, 10), reasons };
}

function scanSecrets(command, cwd) {
  if (!/git\s+commit/.test(command)) return null;
  let diff;
  try {
    diff = execFileSync("git", ["diff", "--cached", "--no-color"], { encoding: "utf8", timeout: 8000, cwd });
  } catch { return null; }
  if (!diff.trim()) return null;
  const violations = [];
  let currentFile = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { currentFile = line.slice(6); continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (SKIP_PATH_RE.test(currentFile) || PLACEHOLDER_RE.test(line)) continue;
    const content = line.slice(1);
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(content)) { violations.push(`${name} in ${currentFile}: ${content.substring(0, 80).trim()}`); break; }
    }
  }
  return violations.length > 0 ? violations : null;
}

function handleBash(hookData) {
  const command = hookData.tool_input?.command || "";
  if (!command) process.exit(0);
  const cwd = hookData.cwd || process.cwd();
  const secrets = scanSecrets(command, cwd);
  if (secrets) {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `[GUARDIAN] Secrets in staged files:\n${secrets.map(v => `  • ${v}`).join("\n")}\n\nRemove or rotate before committing.`,
    }));
    process.exit(2);
  }
  const { score, reasons } = dangerScore(command, cwd);
  if (score >= 7) {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `[GUARDIAN] BLOCKED (danger ${score}/10): ${reasons.join(", ")}. Request explicit confirmation if intentional.`,
    }));
    process.exit(2);
  }
  if (score >= 4) {
    process.stdout.write(JSON.stringify({
      decision: "allow",
      systemMessage: `[GUARDIAN] Caution (danger ${score}/10): ${reasons.join(", ")}. Verify intentional.`,
    }));
  }
  process.exit(0);
}

function handleWebFetch(hookData) {
  const url = hookData.tool_input?.url || "";
  if (!url) process.exit(0);
  if (SAFE_DOMAINS.some(d => url.includes(d))) process.exit(0);
  const warned = WARN_DOMAINS.find(d => url.includes(d));
  if (warned) {
    process.stdout.write(JSON.stringify({
      decision: "allow",
      systemMessage: `[GUARDIAN] ${warned} docs are often Haiku-compressed — verify critical details. Prefer platform.claude.com or developer.mozilla.org where possible.`,
    }));
  }
  process.exit(0);
}

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }
  const tool = hookData.tool_name || "";
  if (tool === "Bash") handleBash(hookData);
  else if (tool === "WebFetch") handleWebFetch(hookData);
  else process.exit(0);
}

main();
