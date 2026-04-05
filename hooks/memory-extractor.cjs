#!/usr/bin/env node
/**
 * Memory Extraction Hook — Stop event
 * When a session ends:
 * 1. Saves session summary to .claude/session-logs/{date}.md
 * 2. Checks adaptive dream trigger (≥24h AND ≥5 sessions since last dream)
 *    and writes a flag file if consolidation is due.
 *
 * Inspired by autoDream's trigger conditions (source leak 2026-03-31).
 * Exit 0 = allow
 */

const fs = require("fs");
const path = require("path");

// Resolved lazily after hookData.cwd is parsed
let LOG_DIR = null;
const MAX_LOGS = 30; // Keep last N session logs

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();

    for (let i = MAX_LOGS; i < files.length; i++) {
      fs.unlinkSync(path.join(LOG_DIR, files[i]));
    }
  } catch {}
}

function getRecentGitActivity(cwd) {
  try {
    const { execSync } = require("child_process");

    // Get files changed in the last hour (approximate session window)
    const changedFiles = execSync(
      'git log --since="1 hour ago" --name-only --pretty=format:""',
      { encoding: "utf8", timeout: 5000, cwd, stdio: ["pipe", "pipe", "pipe"] }
    ).trim().split("\n").filter(Boolean);

    const commits = execSync(
      'git log --since="1 hour ago" --oneline',
      { encoding: "utf8", timeout: 5000, cwd, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    const status = execSync(
      "git status --short",
      { encoding: "utf8", timeout: 5000, cwd, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    return {
      changedFiles: [...new Set(changedFiles)],
      commits: commits || "(no commits in last hour)",
      uncommitted: status || "(clean)",
    };
  } catch {
    return { changedFiles: [], commits: "(git unavailable)", uncommitted: "" };
  }
}

// getNewOrModifiedFiles removed — was Unix-only (find command).
// Git-based detection in getRecentGitActivity covers this cross-platform.

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

  const cwd = hookData.cwd || process.cwd();
  LOG_DIR = path.join(cwd, ".claude", "session-logs");
  const sessionId = hookData.session_id || "unknown";
  const timestamp = new Date().toISOString();
  const dateStr = timestamp.slice(0, 10);
  const timeStr = timestamp.slice(11, 19).replace(/:/g, "-");

  // Gather session activity
  const git = getRecentGitActivity(cwd);

  const log = [
    `# Session Log — ${dateStr} ${timeStr.replace(/-/g, ":")}`,
    ``,
    `- **Session:** ${sessionId}`,
    `- **CWD:** ${cwd}`,
    `- **Time:** ${timestamp}`,
    ``,
  ];

  // Recent commits
  if (git.commits && git.commits !== "(no commits in last hour)") {
    log.push(`## Commits This Session`);
    log.push("```");
    log.push(git.commits);
    log.push("```");
    log.push("");
  }

  // Files changed
  if (git.changedFiles.length > 0) {
    log.push(`## Files Changed (${git.changedFiles.length})`);
    log.push("```");
    log.push(git.changedFiles.join("\n"));
    log.push("```");
    log.push("");
  }

  // Uncommitted work
  if (git.uncommitted && git.uncommitted !== "(clean)") {
    log.push(`## Uncommitted Changes`);
    log.push("```");
    log.push(git.uncommitted);
    log.push("```");
    log.push("");
  }

  // Check for hook files that were created/modified (our toolkit)
  const hookDir = path.join(cwd, ".claude", "hooks");
  if (fs.existsSync(hookDir)) {
    const hookFiles = fs.readdirSync(hookDir).filter((f) => f.endsWith(".cjs") || f.endsWith(".sh"));
    if (hookFiles.length > 0) {
      log.push(`## Active Hooks (${hookFiles.length})`);
      for (const f of hookFiles) {
        log.push(`- ${f}`);
      }
      log.push("");
    }
  }

  log.push(`---`);
  log.push(`*Review this log and promote useful learnings to permanent memory.*`);

  // Only save if there's meaningful activity
  const hasActivity =
    (git.commits && git.commits !== "(no commits in last hour)") ||
    git.changedFiles.length > 0 ||
    (git.uncommitted && git.uncommitted !== "(clean)");

  if (hasActivity) {
    ensureDir(LOG_DIR);
    const filename = `${dateStr}_${timeStr}.md`;
    fs.writeFileSync(path.join(LOG_DIR, filename), log.join("\n"));
    cleanOldLogs();
  }

  // --- Adaptive Dream Trigger ---
  // Track sessions and check if consolidation is due (≥24h AND ≥5 sessions)
  checkDreamTrigger(cwd);

  process.exit(0);
}

function checkDreamTrigger(cwd) {
  const DREAM_STATE = path.join(cwd, ".claude", "dream-trigger-state.json");
  const MIN_SESSIONS = 5;
  const MIN_HOURS = 24;

  let state = { sessionCount: 0, lastDreamTime: 0 };
  try {
    state = JSON.parse(fs.readFileSync(DREAM_STATE, "utf8"));
  } catch { /* first run or corrupt */ }

  state.sessionCount = (state.sessionCount || 0) + 1;
  state.lastCheckTime = Date.now();

  const hoursSinceDream = state.lastDreamTime
    ? (Date.now() - state.lastDreamTime) / (1000 * 60 * 60)
    : Infinity;

  const dreamDue = state.sessionCount >= MIN_SESSIONS && hoursSinceDream >= MIN_HOURS;

  if (dreamDue) {
    // Write flag file — the scheduled task or next session picks this up
    const flagFile = path.join(cwd, ".claude", "dream-due.flag");
    try {
      fs.writeFileSync(flagFile, JSON.stringify({
        reason: `${state.sessionCount} sessions, ${Math.round(hoursSinceDream)}h since last dream`,
        triggeredAt: new Date().toISOString(),
      }));
    } catch { /* non-fatal */ }
  }

  // Save state (atomic write)
  try {
    const tmp = DREAM_STATE + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DREAM_STATE);
  } catch { /* non-fatal */ }
}

main();
