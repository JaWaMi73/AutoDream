#!/usr/bin/env node
/**
 * Learn — CAPTURE layer
 * PostToolUse Write/Edit: capture high-signal edits to session-learnings.md
 * PostToolUse WebSearch: log query + timestamp to search-log.jsonl
 * A-MEM Zettelkasten tagging pattern (HuggingFace Feb 2025).
 * Exit 0 always (fail-open).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const HIGH_SIGNAL_EXTS = new Set([".js", ".cjs", ".ts", ".liquid", ".jsx", ".tsx", ".toml", ".json", ".py", ".css", ".sh"]);
const SKIP_FILES = new Set(["package.json", "package-lock.json", "tsconfig.json", "jsconfig.json", "yarn.lock", "pnpm-lock.yaml"]);

const SIGNAL_KEYWORDS = [
  [/\b(bug.?fix|workaround|gotcha|regression)\b/i,                  "bug-fix"],
  [/\b(api.?pattern|graphql|mutation|query|endpoint|webhook)\b/i,   "api-pattern"],
  [/\b(decision|chose|switched|replaced|refactored|migrated)\b/i,   "decision"],
  [/\b(shopify|polaris|liquid|schema|billing|remix)\b/i,            "shopify"],
  [/\b(hook|dream|context|guardian|memory|compact)\b/i,             "hooks"],
  [/\b(performance|optimis|cache|lazy|debounce|throttle)\b/i,       "perf"],
  [/\b(security|auth|token|credential|permission|rbac)\b/i,         "security"],
];

function extractTags(text) {
  const tags = new Set();
  for (const [re, tag] of SIGNAL_KEYWORDS) {
    if (re.test(text)) tags.add(tag);
  }
  return [...tags];
}

function appendLearning(entry) {
  const file = path.join(os.homedir(), ".claude", "session-learnings.md");
  try { fs.appendFileSync(file, entry + "\n"); } catch { /* non-fatal */ }
}

function handleWriteEdit(hookData) {
  const tool = hookData.tool_name;
  const input = hookData.tool_input || {};
  const filePath = input.file_path || "";
  if (!filePath) return;

  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_FILES.has(base) || !HIGH_SIGNAL_EXTS.has(ext)) return;

  let signalText = "";
  let snippet = "";
  if (tool === "Edit" && input.new_string) {
    signalText = input.new_string.substring(0, 300);
    snippet = signalText.split("\n")[0].trim().substring(0, 80);
  } else if (tool === "Write") {
    signalText = (input.content || "").substring(0, 300);
    // no snippet for writes — avoids logging boilerplate
  }

  const tags = extractTags(signalText);
  if (tags.length === 0) return; // skip low-signal edits/writes

  const tagStr = tags.length > 0 ? `[${tags.join(", ")}] ` : "";
  const desc = snippet || tool.toLowerCase();
  appendLearning(`- ${tagStr}${base} // ${desc}`);
}

function handleWebSearch(hookData) {
  const query = hookData.tool_input?.query || "";
  if (!query) return;
  const logFile = path.join(os.homedir(), ".claude", "search-log.jsonl");
  try {
    fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), q: query }) + "\n");
  } catch { /* non-fatal */ }
}

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const tool = hookData.tool_name || "";
  if (tool === "Write" || tool === "Edit") handleWriteEdit(hookData);
  else if (tool === "WebSearch") handleWebSearch(hookData);
  process.exit(0);
}

main();
