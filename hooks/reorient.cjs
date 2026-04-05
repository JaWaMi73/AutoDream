#!/usr/bin/env node
/**
 * Reorient — REORIENT layer
 * PostCompact: fires after /compact to re-inject priority context.
 * Re-injects: IMPORTANT facts, top project facts, active TODOs, recent commits.
 * Mirrors KAIROS selective re-injection pattern (Anthropic source leak 2026-03-31).
 * Exit 0 always (fail-open).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

function projectKey(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function getProjectFacts(cwd) {
  const key = projectKey(cwd);
  const memPath = path.join(os.homedir(), ".claude", "projects", key, "memory", "MEMORY.md");
  try {
    const lines = fs.readFileSync(memPath, "utf8").split("\n").filter(l => l.trim().startsWith("-"));
    const important = lines.filter(l => /IMPORTANT:/i.test(l)).slice(0, 5);
    const regular = lines.filter(l => !/IMPORTANT:/i.test(l)).slice(0, 3);
    return { important, regular };
  } catch { return { important: [], regular: [] }; }
}

function getActiveTodos(cwd) {
  const todoPaths = [
    path.join(cwd, ".claude", "todos.json"),
    path.join(cwd, ".claude", "tasks.json"),
    path.join(os.homedir(), ".claude", "todos.json"),
  ];
  for (const tp of todoPaths) {
    try {
      if (!fs.existsSync(tp)) continue;
      const raw = JSON.parse(fs.readFileSync(tp, "utf8"));
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.todos) ? raw.todos : [];
      const active = list
        .filter(t => t && t.status !== "completed")
        .map(t => `  - [${t.status || "?"}] ${t.content || ""}`)
        .slice(0, 8);
      if (active.length > 0) return active.join("\n");
    } catch { /* try next */ }
  }
  return null;
}

function getRecentCommits(cwd) {
  try {
    return execFileSync("git", ["log", "-3", "--oneline"], {
      encoding: "utf8", timeout: 5000, cwd, stdio: ["pipe", "pipe", "pipe"],
    }).trim() || null;
  } catch { return null; }
}

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const cwd = hookData.cwd || process.cwd();
  const parts = ["[REORIENT] Context compacted. Re-injecting priority context:"];

  const { important, regular } = getProjectFacts(cwd);
  if (important.length > 0) parts.push("IMPORTANT facts:\n" + important.join("\n"));
  if (regular.length > 0) parts.push("Project facts:\n" + regular.join("\n"));

  const todos = getActiveTodos(cwd);
  if (todos) parts.push("Active TODOs:\n" + todos);

  const commits = getRecentCommits(cwd);
  if (commits) parts.push("Recent commits:\n" + commits);

  process.stdout.write(JSON.stringify({ systemMessage: parts.join("\n\n") }));
  process.exit(0);
}

main();
