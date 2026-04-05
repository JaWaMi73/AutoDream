#!/usr/bin/env node
/**
 * Context — ENRICH layer
 * UserPromptSubmit: frustration detection, resume detection,
 * project memory injection, global knowledge injection, context health warnings.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const FRUSTRATION_PATTERNS = [
  /\b(fuck|shit|wtf|ffs|damn it|bloody)\b/i,
  /doesn'?t work/i,
  /still (broken|failing|not working|the same)/i,
  /same (error|issue|problem|thing)/i,
  /not (working|fixed|helping)/i,
  /broken again|nothing works/i,
  /you already|told you|so frustrating|this sucks/i,
  /\bugh+\b|\bagain[!?]+/i,
];

const RESUME_PATTERNS = [
  /^(yes|yeah|yep|yup|ok|okay|sure|fine)[.!?]?$/i,
  /^(continue|proceed|go ahead|keep going|next|do it)[.!?]?$/i,
  /^(resume|carry on|and\?|more|go)[.!?]?$/i,
];

function projectKey(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function injectProjectMemory(cwd) {
  const key = projectKey(cwd);
  const memPath = path.join(os.homedir(), ".claude", "projects", key, "memory", "MEMORY.md");
  try {
    const lines = fs.readFileSync(memPath, "utf8").split("\n").filter(l => l.trim().startsWith("-"));
    const important = lines.filter(l => /IMPORTANT:/i.test(l)).slice(0, 5);
    const regular = lines.filter(l => !/IMPORTANT:/i.test(l)).slice(0, 5);
    const facts = [...important, ...regular].slice(0, 10);
    return facts.length > 0 ? `Project memory:\n${facts.join("\n")}` : null;
  } catch { return null; }
}

function parseKeywords(content) {
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const kw = m[1].match(/keywords:\s*(.+)/);
  if (!kw) return [];
  return kw[1].split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
}

function injectGlobalKnowledge(prompt, memDir) {
  const injected = [];
  try {
    const files = fs.readdirSync(memDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(memDir, file), "utf8");
        const keywords = parseKeywords(content);
        if (keywords.length === 0) continue;
        if (!keywords.some(k => k && prompt.toLowerCase().includes(k))) continue;
        const body = content.replace(/^---[\s\S]*?---\n?/, "").split("\n").slice(0, 12).join("\n").trim();
        if (body) injected.push(`[${file.replace(".md", "")}]\n${body}`);
      } catch { /* skip bad file */ }
    }
  } catch { /* no memory dir */ }
  return injected.length > 0 ? injected.join("\n\n") : null;
}

function contextHealth(injectedChars) {
  if (injectedChars >= 10000) return `[CONTEXT] CRITICAL: ${Math.round(injectedChars / 1000)}K chars injected this prompt — run /compact now.`;
  if (injectedChars >= 6000) return `[CONTEXT] Warning: ${Math.round(injectedChars / 1000)}K chars injected — consider /compact soon.`;
  return null;
}

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const prompt = (hookData.prompt || hookData.user_prompt || "").trim();
  const cwd = hookData.cwd || process.cwd();
  const memDir = path.join(os.homedir(), ".claude", "memory");
  const parts = [];

  if (FRUSTRATION_PATTERNS.some(p => p.test(prompt))) {
    parts.push("User is frustrated. Lead directly with the fix — no preamble, no apologies. State root cause in one sentence. Show corrected code immediately. Zero filler.");
  } else if (RESUME_PATTERNS.some(p => p.test(prompt))) {
    parts.push("User wants continuation. Resume exactly where you stopped. No recap. No re-introduction.");
  }

  const projMem = injectProjectMemory(cwd);
  if (projMem) parts.push(projMem);

  const globalKnowledge = injectGlobalKnowledge(prompt, memDir);
  if (globalKnowledge) parts.push(globalKnowledge);

  // Health check runs last — measures total injection size accurately
  const health = contextHealth(parts.join("\n\n").length);
  if (health) parts.push(health);

  if (parts.length === 0) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: parts.join("\n\n"),
    },
  }));
  process.exit(0);
}

main();
