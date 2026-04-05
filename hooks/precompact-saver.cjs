#!/usr/bin/env node
/**
 * PreCompact State Saver
 * Fires on PreCompact event — saves critical context to disk before
 * auto-compaction destroys earlier conversation details.
 *
 * Saves to: .claude/compaction-snapshots/{timestamp}.md
 *
 * Exit 0 = allow compaction to proceed
 */

const fs = require("fs");
const path = require("path");

// Resolved lazily after hookData.cwd is parsed
let SNAPSHOT_DIR = null;
const MAX_SNAPSHOTS = 10; // Keep last N snapshots

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanOldSnapshots() {
  try {
    const files = fs.readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();

    // Keep only the latest MAX_SNAPSHOTS
    for (let i = MAX_SNAPSHOTS; i < files.length; i++) {
      fs.unlinkSync(path.join(SNAPSHOT_DIR, files[i]));
    }
  } catch {}
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

  // Build snapshot content from available hook data
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sessionId = hookData.session_id || "unknown";
  const cwd = hookData.cwd || process.cwd();
  SNAPSHOT_DIR = path.join(cwd, ".claude", "compaction-snapshots");
  const compactType = hookData.compact_type || hookData.matcher || "auto";

  const snapshot = [
    `# Compaction Snapshot`,
    ``,
    `- **Time:** ${new Date().toISOString()}`,
    `- **Session:** ${sessionId}`,
    `- **CWD:** ${cwd}`,
    `- **Type:** ${compactType}`,
    ``,
    `## Context at Compaction`,
    ``,
    `This snapshot was auto-saved when context compaction fired.`,
    `Earlier conversation details may have been summarized or lost.`,
    ``,
    `### Recent Files Modified`,
    ``,
  ];

  // Try to capture recent git changes as a proxy for what was being worked on
  try {
    const { execSync } = require("child_process");
    const recentFiles = execSync("git diff --name-only HEAD~3 HEAD", {
      encoding: "utf8",
      timeout: 5000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (recentFiles) {
      snapshot.push("```");
      snapshot.push(recentFiles);
      snapshot.push("```");
    } else {
      snapshot.push("(no recent git changes detected)");
    }
  } catch {
    snapshot.push("(git not available)");
  }

  snapshot.push("");
  snapshot.push("### Git Status at Compaction");
  snapshot.push("");

  try {
    const { execSync } = require("child_process");
    const status = execSync("git status --short", {
      encoding: "utf8",
      timeout: 5000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (status) {
      snapshot.push("```");
      snapshot.push(status);
      snapshot.push("```");
    } else {
      snapshot.push("(clean working tree)");
    }
  } catch {
    snapshot.push("(git not available)");
  }

  snapshot.push("");
  snapshot.push("### Active TODO State");
  snapshot.push("");

  // Check for any todo/task files
  const todoFiles = [
    path.join(cwd, ".claude", "todos.json"),
    path.join(cwd, ".claude", "tasks.json"),
  ];

  let foundTodos = false;
  for (const todoFile of todoFiles) {
    if (fs.existsSync(todoFile)) {
      try {
        const todos = JSON.parse(fs.readFileSync(todoFile, "utf8"));
        // Extract first 15 items to avoid truncating mid-JSON
        const list = Array.isArray(todos) ? todos : (Array.isArray(todos?.todos) ? todos.todos : []);
        const trimmed = list.slice(0, 15);
        snapshot.push("```json");
        snapshot.push(JSON.stringify(trimmed, null, 2));
        snapshot.push("```");
        if (list.length > 15) snapshot.push(`(${list.length - 15} more items truncated)`);
        foundTodos = true;
      } catch {}
    }
  }
  if (!foundTodos) {
    snapshot.push("(no todo files found)");
  }

  // Save snapshot
  ensureDir(SNAPSHOT_DIR);
  const filename = `${timestamp}.md`;
  fs.writeFileSync(path.join(SNAPSHOT_DIR, filename), snapshot.join("\n"));

  // Clean old snapshots
  cleanOldSnapshots();

  // Inject a system message so Claude knows state was saved
  const output = {
    systemMessage:
      `[PRECOMPACT] Context is being compacted. ` +
      `A snapshot of the current state has been saved to .claude/compaction-snapshots/${filename}. ` +
      `If you need to recover context about what you were working on, read that file.`,
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main();
