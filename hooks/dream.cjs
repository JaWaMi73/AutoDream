#!/usr/bin/env node
/**
 * Dream — MAINTAIN layer
 * Stop event: 6-step memory maintenance pipeline.
 * 1. consolidateLearnings  — archive session-learnings.md
 * 2. checkGlobalMemoryFiles — flag stale/decay memory files (>60 days)
 * 3. checkHookChanges       — flag hooks changed since last dream:verified stamp
 * 4. detectRecurringThemes  — Zettelkasten tag frequency across archives (A-MEM)
 * 5. expirePendingReview    — strip stale Pending Review sections (>7 days)
 * 6. processMemoryFile      — dedup + stamp dream:verified on project MEMORY.md
 * Never blocks — always exits 0.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const MEM_DIR = path.join(HOME, ".claude", "memory");
const LEARN_FILE = path.join(HOME, ".claude", "session-learnings.md");
const ARCHIVE_DIR = path.join(HOME, ".claude");

const DECAY_PATTERNS = [
  /railway\.app/i,
  /client_id\s*[:=]\s*['"][a-zA-Z0-9]{20,}/i,
  /v\d+\.\d+\.\d+-\d{8}/i,
];

function projectKey(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function consolidateLearnings() {
  try {
    if (!fs.existsSync(LEARN_FILE)) return;
    const content = fs.readFileSync(LEARN_FILE, "utf8").trim();
    if (!content) return;
    const date = new Date().toISOString().slice(0, 10);
    const archivePath = path.join(ARCHIVE_DIR, `learnings-${date}.md`);
    const header = fs.existsSync(archivePath) ? "\n" : `# Session Learnings — ${date}\n\n`;
    fs.appendFileSync(archivePath, header + content + "\n");
    fs.writeFileSync(LEARN_FILE, "");
  } catch { /* non-fatal */ }
}

function checkGlobalMemoryFiles() {
  const flags = [];
  try {
    if (!fs.existsSync(MEM_DIR)) return flags;
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(MEM_DIR).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
    for (const file of files) {
      try {
        const fp = path.join(MEM_DIR, file);
        const stat = fs.statSync(fp);
        const content = fs.readFileSync(fp, "utf8");
        if (stat.mtimeMs < cutoff) flags.push(`${file}: not updated in >60 days`);
        else if (DECAY_PATTERNS.some(re => re.test(content))) flags.push(`${file}: contains decay patterns (URLs/IDs/stale versions)`);
      } catch { /* skip */ }
    }
  } catch { /* no mem dir */ }
  return flags;
}

function checkHookChanges() {
  const flags = [];
  try {
    const refPath = path.join(MEM_DIR, "reference_our_hooks.md");
    if (!fs.existsSync(refPath)) return flags;
    const refContent = fs.readFileSync(refPath, "utf8");
    const stampMatch = refContent.match(/dream:verified (\d{4}-\d{2}-\d{2})/);
    if (!stampMatch) return flags;
    const verifiedAt = new Date(stampMatch[1]).getTime() + 24 * 60 * 60 * 1000;
    const hookDir = path.join(HOME, ".claude", "hooks");
    if (!fs.existsSync(hookDir)) return flags;
    for (const f of fs.readdirSync(hookDir).filter(f => f.endsWith(".cjs"))) {
      try {
        if (fs.statSync(path.join(hookDir, f)).mtimeMs > verifiedAt) flags.push(f);
      } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
  return flags;
}

function detectRecurringThemes() {
  const tagCounts = {};
  try {
    const files = fs.readdirSync(ARCHIVE_DIR)
      .filter(f => /^learnings-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort().slice(-30);
    if (files.length < 3) return [];
    for (const file of files) {
      try {
        const date = file.replace("learnings-", "").replace(".md", "");
        const content = fs.readFileSync(path.join(ARCHIVE_DIR, file), "utf8");
        const seen = new Set();
        for (const m of content.matchAll(/\[([^\]]+)\]/g)) {
          for (const tag of m[1].split(",").map(t => t.trim())) {
            const key = tag + "|" + date;
            if (!tag || seen.has(key)) continue;
            seen.add(key);
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
        }
      } catch { /* skip unreadable archive file */ }
    }
  } catch { return []; }
  return Object.entries(tagCounts)
    .filter(([, n]) => n >= 3)
    .map(([tag, n]) => `"${tag}" (${n} sessions)`);
}

function expirePendingReview(cwd) {
  const memPath = path.join(HOME, ".claude", "projects", projectKey(cwd), "memory", "MEMORY.md");
  try {
    if (!fs.existsSync(memPath)) return;
    let content = fs.readFileSync(memPath, "utf8");
    const m = content.match(/## Pending Review\s*<!--\s*added:\s*(\d{4}-\d{2}-\d{2})\s*-->/);
    if (!m) return;
    const age = (Date.now() - new Date(m[1]).getTime()) / (1000 * 60 * 60 * 24);
    if (age > 7) {
      content = content.replace(/## Pending Review[\s\S]*?(?=## |$)/, "");
      fs.writeFileSync(memPath, content.trim() + "\n");
    }
  } catch { /* non-fatal */ }
}

function processMemoryFile(cwd) {
  const memPath = path.join(HOME, ".claude", "projects", projectKey(cwd), "memory", "MEMORY.md");
  try {
    if (!fs.existsSync(memPath)) return;
    let lines = fs.readFileSync(memPath, "utf8").split("\n");
    const seen = new Set();
    lines = lines.filter(line => {
      const k = line.trim();
      if (!k || k.startsWith("#") || k.startsWith("<!--")) return true;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    const today = new Date().toISOString().slice(0, 10);
    const stamp = `<!-- dream:verified ${today} -->`;
    // Remove ALL existing dream:verified stamps (prevents accumulation across sessions)
    lines = lines.filter(l => !/<!--\s*dream:verified/.test(l));
    // Trim trailing blank lines then append stamp
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", stamp);
    fs.writeFileSync(memPath, lines.join("\n"));
  } catch { /* non-fatal */ }
}

function main() {
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const cwd = hookData.cwd || process.cwd();

  consolidateLearnings();
  const staleFiles = checkGlobalMemoryFiles();
  const changedHooks = checkHookChanges();
  const themes = detectRecurringThemes();
  expirePendingReview(cwd);
  processMemoryFile(cwd);

  const msgs = [];
  if (staleFiles.length > 0) msgs.push(`[DREAM] Stale memory files:\n${staleFiles.map(f => `  • ${f}`).join("\n")}`);
  if (changedHooks.length > 0) msgs.push(`[DREAM] Hooks changed since last verification — update reference_our_hooks.md:\n${changedHooks.map(f => `  • ${f}`).join("\n")}`);
  if (themes.length > 0) msgs.push(`[DREAM] Recurring themes (consider promoting to permanent memory):\n${themes.map(t => `  • ${t}`).join("\n")}`);

  if (msgs.length > 0) process.stdout.write(JSON.stringify({ systemMessage: msgs.join("\n\n") }));
  process.exit(0);
}

main();
