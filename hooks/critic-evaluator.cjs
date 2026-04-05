#!/usr/bin/env node
/**
 * Critic Evaluator — Heuristic Danger Scoring for Bash Commands
 * Triggers on PreToolUse (Bash) alongside circuit-breaker.
 * Scores commands on a 0-10 danger scale using pattern matching.
 * Inspired by Claude Code's "critic pattern" permission classification
 * (source leak 2026-03-31).
 *
 * Score 0-3: allow silently
 * Score 4-6: allow + inject warning systemMessage
 * Score 7+:  block (exit 2)
 *
 * Exit 0 = allow, Exit 2 = block, Exit 1 = error (fail-open)
 */
"use strict";

const fs = require("fs");
const path = require("path");

// Danger patterns: [regex, score, description]
const PATTERNS = [
  // Destructive file operations
  [/\brm\b.*-[a-z]*r[a-z]*f|rm\b.*-[a-z]*f[a-z]*r|\brm\s+-rf\b/i, 5, "recursive force delete"],
  [/\brm\s+-f\b/i, 3, "force delete"],
  [/\bmkfs\b|\bformat\s/i, 8, "filesystem format"],
  [/>\s*\/dev\/(?!null)[a-z]/i, 7, "write to device"],

  // Git destructive
  [/git\s+push\s+.*--force|git\s+push\s+-f\b/i, 4, "git force push"],
  [/git\s+reset\s+--hard/i, 4, "git hard reset"],
  [/git\s+clean\s+-[a-z]*f/i, 3, "git clean force"],
  [/git\s+branch\s+-D\b/i, 2, "git branch force delete"],

  // Database destructive
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, 7, "SQL drop"],
  [/\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, 6, "SQL delete without WHERE"],
  [/\bTRUNCATE\b/i, 7, "SQL truncate"],

  // Permission escalation
  [/\bsudo\b/i, 5, "sudo escalation"],
  [/\bchmod\s+777\b/i, 3, "world-writable permissions"],
  [/\bchown\s+-R\s+root/i, 4, "recursive root ownership"],

  // System-critical targets
  [/\/etc\/passwd|\/etc\/shadow/i, 6, "system auth files"],
  [/~\/\.claude\/settings/i, 5, "Claude settings modification"],
  [/~\/\.ssh\//i, 4, "SSH directory access"],
  [/~\/\.gnupg\//i, 4, "GPG directory access"],

  // Network exfiltration signals
  [/\bcurl\b.*\|\s*\bbash\b/i, 6, "curl pipe to bash"],
  [/\bwget\b.*\|\s*\bsh\b/i, 6, "wget pipe to shell"],

  // Complexity / obfuscation
  [/\beval\b/i, 2, "eval usage"],
  [/\bbase64\s+-d\b.*\|\s*(bash|sh)/i, 5, "base64 decode to shell"],
];

// Extra: pipe chain length scoring
function countPipeChains(cmd) {
  const pipes = (cmd.match(/\|/g) || []).length;
  return pipes > 3 ? 2 : 0;
}

// Normalize path separators for cross-platform comparison
function normPath(p) { return p.replace(/\\/g, "/").replace(/\/+$/, ""); }

// Check if command targets paths outside CWD
function outsideCwdScore(cmd, cwd) {
  if (!cwd || cwd.length < 4) return 0;
  const ncwd = normPath(cwd);
  if (ncwd === "/" || ncwd === "C:" || ncwd === "C:/") return 0;
  // Match both Unix (/foo) and Windows (C:\foo, C:/foo) absolute paths
  const absPaths = cmd.match(/(?:^|\s)([A-Za-z]:[\\\/][^\s]+|\/[^\s]+)/g) || [];
  for (const p of absPaths) {
    const trimmed = normPath(p.trim());
    if (trimmed === "/dev/null") continue;
    if (!trimmed.startsWith(ncwd)) return 3;
  }
  return 0;
}

function evaluateCommand(command, cwd) {
  let totalScore = 0;
  const reasons = [];

  for (const [regex, score, desc] of PATTERNS) {
    if (regex.test(command)) {
      totalScore += score;
      reasons.push(`${desc} (+${score})`);
    }
  }

  const pipeScore = countPipeChains(command);
  if (pipeScore > 0) {
    totalScore += pipeScore;
    reasons.push(`long pipe chain (+${pipeScore})`);
  }

  const cwdScore = outsideCwdScore(command, cwd);
  if (cwdScore > 0) {
    totalScore += cwdScore;
    reasons.push(`targets outside CWD (+${cwdScore})`);
  }

  // Cap at 10
  totalScore = Math.min(totalScore, 10);

  return { score: totalScore, reasons };
}

function main() {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Only evaluate on PreToolUse for Bash
  const toolName = hookData.tool_name || "";
  if (toolName !== "Bash") {
    process.exit(0);
  }

  const command = hookData.tool_input?.command || "";
  if (!command) {
    process.exit(0);
  }

  const cwd = hookData.cwd || process.cwd();
  const { score, reasons } = evaluateCommand(command, cwd);

  if (score >= 7) {
    // BLOCK
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: [
          `[CRITIC] BLOCKED (danger score: ${score}/10).`,
          `Reasons: ${reasons.join(", ")}.`,
          `Command: ${command.substring(0, 100)}${command.length > 100 ? "..." : ""}`,
          "If this is intentional, ask the user for explicit confirmation.",
        ].join(" "),
      })
    );
    process.exit(2);
  }

  if (score >= 4) {
    // WARN
    const snippet = command.length > 80 ? command.slice(0, 80) + "…" : command;
    process.stdout.write(
      JSON.stringify({
        decision: "allow",
        systemMessage: [
          `[CRITIC] Caution (danger score: ${score}/10): ${reasons.join(", ")}.`,
          `Command: \`${snippet}\``,
          "Proceeding — confirm this is intentional before continuing.",
        ].join(" "),
      })
    );
    process.exit(0);
  }

  // Score 0-3: allow silently
  process.exit(0);
}

main();
