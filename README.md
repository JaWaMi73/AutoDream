# AutoDream

> The most complete public infrastructure for Claude Code — built around the same architecture Anthropic uses internally.

AutoDream is a production hook system that gives Claude Code three operating modes: **active** (hooks augment every action), **AFK** (agents work while you're away), and **maintenance** (memory cleans itself overnight). Zero dead time.

---

## Why this exists

Claude Code has a memory problem. Every session starts cold. `/compact` destroys context. Dangerous commands run without warning. Learnings evaporate.

In March 2026, a 512K-line Anthropic source leak revealed their internal solution: **KAIROS** — a 3-layer memory system, autonomous background agents, and proactive context management. It's unreleased. This repo is the public implementation of those patterns.

---

## Three operating modes

```
┌─────────────────────────────────────────────────────┐
│  MODE 1: ACTIVE (you're working)                    │
│  Hooks fire on every action                         │
│  • Guardian blocks dangerous commands               │
│  • Context injects project memory every prompt      │
│  • Learn captures decisions automatically           │
│  • Verification catches syntax errors immediately   │
├─────────────────────────────────────────────────────┤
│  MODE 2: AFK (you're away)                          │
│  Agents work the queue every 30 min                 │
│  • afk-worker processes tasks you left behind       │
│  • kairos-heartbeat monitors system health          │
│  • Wake up to a report, not a blank slate           │
├─────────────────────────────────────────────────────┤
│  MODE 3: MAINTENANCE (you're asleep)                │
│  System resets itself at 3:17 AM                    │
│  • Memory consolidated and deduplicated             │
│  • Stale entries pruned                             │
│  • Session signals extracted and promoted           │
└─────────────────────────────────────────────────────┘
```

---

## Hook architecture

11 hooks across all 6 Claude Code events:

### PreToolUse — PROTECT layer
| Hook | Matcher | What it does |
|---|---|---|
| `guardian.cjs` | Bash \| WebFetch | Danger scoring 0-10, blocks ≥7. Scans staged files for secrets on git commit. |
| `critic-evaluator.cjs` | Bash | Second independent danger scorer. Warns 4-6, blocks ≥7. |
| `circuit-breaker.cjs` | Bash | Tracks API failures. Opens circuit after 3 failures, auto-resets after 30s. |

### UserPromptSubmit — ENRICH layer
| Hook | What it does |
|---|---|
| `context.cjs` | Injects project memory, global knowledge, frustration/resume detection, context health warnings. |

### PostToolUse — CAPTURE + VERIFY + MONITOR
| Hook | Matcher | What it does |
|---|---|---|
| `learn.cjs` | Write \| Edit \| WebSearch | Captures high-signal edits with Zettelkasten tags. Logs search queries. |
| `verification-hook.cjs` | Write \| Edit | Syntax checks JS/JSON/Python/YAML/Bash after every write. |
| `circuit-breaker.cjs` | Bash | Records API outcomes, updates circuit state. |
| `microcompact.cjs` | All tools | Estimates token usage. Warns at 70% / 85% / 95% capacity. |

### PreCompact — PRESERVE
| Hook | What it does |
|---|---|
| `precompact-saver.cjs` | Saves git state + TODO state to `.claude/compaction-snapshots/` before context is destroyed. |

### PostCompact — REORIENT
| Hook | What it does |
|---|---|
| `reorient.cjs` | Re-injects IMPORTANT facts, project context, active TODOs, recent commits after `/compact`. |

### Stop — MAINTAIN
| Hook | What it does |
|---|---|
| `memory-extractor.cjs` | Logs session activity. Writes `dream-due.flag` after ≥5 sessions + ≥24h (adaptive trigger). |
| `dream.cjs` | Consolidates learnings, deduplicates memory, detects decay, stamps `dream:verified`. |

---

## Autonomous agents

| Agent | Schedule | What it does |
|---|---|---|
| `kairos-heartbeat` | Every 15 min | Checks dream flags, git health, dead memory links, signal backlog |
| `memory-consolidation-nightly` | 3:17 AM daily | Full memory audit, dedup, signal grep, stale entry pruning |
| `afk-worker` | Every 30 min | Works tasks from `~/.claude/afk-queue.md`, writes report to `~/.claude/afk-report.md` |
| `dream-auditor` | On demand | Runs full test suite, syntax checks all hooks, verifies wiring |
| `memory-curator` | On demand | Reads stale flagged files, updates or deletes, promotes Pending Review items |

---

## Memory architecture

Three layers, mirroring the KAIROS design:

```
~/.claude/
  memory/                          ← GLOBAL (cross-project knowledge)
    reference_*.md                 ← keyword-matched, injected when relevant

~/.claude/projects/<key>/memory/
  MEMORY.md                        ← PROJECT (injected every session)

~/.claude/session-learnings.md     ← SESSION (captured live, consolidated by dream)
```

`context.cjs` injects the right layer at the right time. `dream.cjs` promotes session → project. `memory-curator` keeps global layer clean.

---

## vs KAIROS (Anthropic internal)

| Feature | KAIROS | Claude Dream |
|---|---|---|
| 3-layer memory | ✅ | ✅ |
| Proactive context injection | ✅ | ✅ |
| Pre/post compaction hooks | ✅ | ✅ |
| Danger scoring | ✅ | ✅ |
| Background heartbeat | ✅ | ✅ |
| AFK task queue | ✅ | ✅ |
| Autonomous code writing | ✅ | ⚠️ (queue-based, not inferred) |
| Generative background reasoning | ✅ | ❌ (needs API) |

Everything except the last two is implemented. The inference gap closes when Anthropic ships KAIROS publicly — this system is designed to be a drop-in wrapper around it when that happens.

---

## Quick install

See [INSTALL.md](INSTALL.md) for full setup. The short version:

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/autodream ~/.claude/autodream

# 2. Copy hooks
cp ~/.claude/autodream/hooks/*.cjs ~/.claude/hooks/

# 3. Merge settings
# Copy the hooks block from settings.json into your ~/.claude/settings.json

# 4. Create your first project memory
mkdir -p ~/.claude/projects/$(echo $PWD | sed 's/[^a-zA-Z0-9]/-/g')/memory
echo "# Project Memory" > ~/.claude/projects/$(echo $PWD | sed 's/[^a-zA-Z0-9]/-/g')/memory/MEMORY.md
```

Done. All hooks fire automatically from that point.

---

## What changes immediately

- Every prompt carries project context — no more repeating yourself
- `/compact` no longer destroys working context
- Dangerous commands blocked before they run
- Learnings captured automatically, memory maintained overnight
- Drop tasks in a queue before stepping away, return to a report

---

## Repo structure

```
autodream/
  hooks/                  ← 11 production hooks
  agents/                 ← 5 scheduled agent prompts
  settings.json           ← ready-to-merge settings block
  INSTALL.md              ← full setup guide
  README.md               ← this file
```

---

## License

MIT — use it, fork it, build on it.

---

*AutoDream — built by reverse-engineering the KAIROS architecture from the Anthropic source leak (2026-03-31) and reimplementing it as public Claude Code hooks.*
