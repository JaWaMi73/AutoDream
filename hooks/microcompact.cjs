#!/usr/bin/env node
/**
 * MicroCompact — Proactive Context Capacity Monitor
 * Triggers on PostToolUse (all tools, no matcher)
 * Tracks estimated token consumption per session and injects
 * advisory warnings before compaction threshold is reached.
 * Inspired by Claude Code's MicroCompact strategy (source leak 2026-03-31).
 *
 * Performance: No git, no child_process, no file scanning. Must complete <50ms.
 * Consistency: Eventual — concurrent PostToolUse calls may lose increments.
 * This is acceptable; token estimates are heuristic, not precise.
 * Exit 0 = allow (always), Exit 1 = error (fail-open)
 */
"use strict";

const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "..", "microcompact-state.json");

// Thresholds based on 200K token context window, compaction at ~167K
const ADVISORY_THRESHOLD = 120000;  // ~70% — start thinking about wrapping up
const URGENT_THRESHOLD = 140000;    // ~85% — compaction imminent
const CRITICAL_THRESHOLD = 160000;  // ~95% — last chance

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

  const sessionId = hookData.session_id || "unknown";

  // Estimate tokens from this tool call (rough: chars / 4)
  const payloadSize = input.length;
  let resultSize = 0;
  if (hookData.tool_result) {
    try {
      resultSize = JSON.stringify(hookData.tool_result).length;
    } catch {
      // Circular references or other stringify failures — estimate from input
      resultSize = payloadSize;
    }
  }
  const tokenEstimate = Math.round((payloadSize + resultSize) / 4);

  // Read or initialize state
  let state = { sessionId: "", estimatedTokens: 0, warningLevel: 0 };
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    state = JSON.parse(raw);
  } catch {
    // First call or corrupt file — fresh state
  }

  // Reset if new session
  if (state.sessionId !== sessionId) {
    state = { sessionId, estimatedTokens: 0, warningLevel: 0 };
  }

  // Increment
  state.estimatedTokens += tokenEstimate;

  let output = null;

  if (state.estimatedTokens >= CRITICAL_THRESHOLD && state.warningLevel < 3) {
    state.warningLevel = 3;
    output = {
      decision: "allow",
      systemMessage: [
        "[MICROCOMPACT] CRITICAL: Context at ~95% capacity (~" +
          Math.round(state.estimatedTokens / 1000) + "K tokens).",
        "Compaction will fire any moment. IMMEDIATELY:",
        "1. Save any uncommitted decisions to memory",
        "2. Mark completed TODOs",
        "3. Summarize current progress in a brief message",
      ].join(" "),
    };
  } else if (
    state.estimatedTokens >= URGENT_THRESHOLD &&
    state.warningLevel < 2
  ) {
    state.warningLevel = 2;
    output = {
      decision: "allow",
      systemMessage: [
        "[MICROCOMPACT] WARNING: Context at ~85% capacity (~" +
          Math.round(state.estimatedTokens / 1000) + "K tokens).",
        "Compaction imminent. Prioritize finishing current task",
        "and saving key decisions to memory.",
      ].join(" "),
    };
  } else if (
    state.estimatedTokens >= ADVISORY_THRESHOLD &&
    state.warningLevel < 1
  ) {
    state.warningLevel = 1;
    output = {
      decision: "allow",
      systemMessage: [
        "[MICROCOMPACT] Advisory: Context at ~70% capacity (~" +
          Math.round(state.estimatedTokens / 1000) + "K tokens).",
        "Consider wrapping up current task scope.",
        "Save important context to memory if not already done.",
      ].join(" "),
    };
  }

  // Write state atomically (write to temp, rename) to prevent race conditions
  try {
    const tmpFile = STATE_FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(state));
    fs.renameSync(tmpFile, STATE_FILE);
  } catch {
    // Non-fatal — we just lose tracking
  }

  if (output) {
    process.stdout.write(JSON.stringify(output));
  }

  process.exit(0);
}

main();
