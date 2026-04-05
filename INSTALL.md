# Installation Guide

Full setup takes about 10 minutes.

## Prerequisites

- Claude Code installed and working
- Node.js 18+ (`node --version`)
- Git

---

## Step 1 — Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/autodream
```

---

## Step 2 — Copy hooks to global location

**Mac/Linux:**
```bash
mkdir -p ~/.claude/hooks
cp autodream/hooks/*.cjs ~/.claude/hooks/
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\hooks"
Copy-Item "autodream\hooks\*.cjs" "$env:USERPROFILE\.claude\hooks\"
```

---

## Step 3 — Wire hooks into settings.json

Open (or create) `~/.claude/settings.json` and add the hooks block.

**Mac/Linux path:** `~/.claude/settings.json`
**Windows path:** `C:\Users\<you>\.claude\settings.json`

Replace `YOUR_HOME` with your actual home path:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|WebFetch",
        "hooks": [
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/guardian.cjs" }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/critic-evaluator.cjs" },
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/circuit-breaker.cjs" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/context.cjs" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|WebSearch",
        "hooks": [
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/learn.cjs" }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/verification-hook.cjs" }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/circuit-breaker.cjs" }
        ]
      },
      {
        "hooks": [
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/microcompact.cjs" }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/precompact-saver.cjs" }
        ]
      }
    ],
    "PostCompact": [
      {
        "hooks": [
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/reorient.cjs" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/memory-extractor.cjs" },
          { "type": "command", "command": "node YOUR_HOME/.claude/hooks/dream.cjs" }
        ]
      }
    ]
  }
}
```

---

## Step 4 — Create your first project memory file

Navigate to your project directory, then:

**Mac/Linux:**
```bash
PROJECT_KEY=$(echo $PWD | sed 's/[^a-zA-Z0-9]/-/g' | sed 's/^-*//' | sed 's/-*$//')
mkdir -p ~/.claude/projects/$PROJECT_KEY/memory
cat > ~/.claude/projects/$PROJECT_KEY/memory/MEMORY.md << EOF
# Project Memory

- Project started $(date +%Y-%m-%d)
EOF
echo "Created: ~/.claude/projects/$PROJECT_KEY/memory/MEMORY.md"
```

**Windows (PowerShell):**
```powershell
$key = ($PWD.Path -replace '[^a-zA-Z0-9]', '-').Trim('-')
$memPath = "$env:USERPROFILE\.claude\projects\$key\memory"
New-Item -ItemType Directory -Force -Path $memPath
"# Project Memory`n`n- Project started $(Get-Date -Format yyyy-MM-dd)" | Out-File "$memPath\MEMORY.md"
Write-Host "Created: $memPath\MEMORY.md"
```

---

## Step 5 — Verify everything works

```bash
# Syntax check all hooks
for f in ~/.claude/hooks/*.cjs; do
  node --check "$f" && echo "✅ $f" || echo "❌ $f"
done

# Smoke test each hook
echo '{}' | node ~/.claude/hooks/guardian.cjs && echo "guardian: OK"
echo '{}' | node ~/.claude/hooks/context.cjs && echo "context: OK"
echo '{}' | node ~/.claude/hooks/dream.cjs && echo "dream: OK"
```

All should exit 0.

---

## Step 6 — Create global memory directory

```bash
mkdir -p ~/.claude/memory
mkdir -p ~/.claude/session-logs
```

The hooks write here automatically. Nothing else needed.

---

## Step 7 — (Optional) Set up AFK mode

Create the task queue file:

```bash
cat > ~/.claude/afk-queue.md << 'EOF'
# AFK Queue

Drop tasks here before stepping away. afk-worker picks them up within 30 min.

## Queue

<!-- Add tasks below this line -->

## Completed
EOF
```

Then create the `afk-worker` scheduled task in Claude Code using the prompt in `agents/afk-worker.md`.

---

## How the project key works

Claude Dream maps your project directory to a memory path using this formula:

```
/path/to/my-project  →  -path-to-my-project
C:\Users\me\project  →  C--Users-me-project
```

Everything non-alphanumeric becomes a dash. That's the folder name under `~/.claude/projects/`.

To find your key:

**Mac/Linux:** `echo $PWD | sed 's/[^a-zA-Z0-9]/-/g'`
**Windows:** `($PWD.Path -replace '[^a-zA-Z0-9]', '-')`

---

## What fires and when

| You do | Hook fires | Effect |
|---|---|---|
| Type a prompt | `context.cjs` | Project memory injected |
| Run a Bash command | `guardian.cjs` + `critic-evaluator.cjs` | Danger scored, blocked if ≥7 |
| Write or edit a file | `learn.cjs` + `verification-hook.cjs` | Signal captured, syntax checked |
| Run `/compact` | `precompact-saver.cjs` then `reorient.cjs` | State saved, context re-injected |
| End session | `memory-extractor.cjs` + `dream.cjs` | Session logged, memory consolidated |

---

## Troubleshooting

**Hook not firing**
- Check `~/.claude/settings.json` — confirm the path matches your actual home directory
- Run `echo '{}' | node ~/.claude/hooks/guardian.cjs` — should exit 0 silently

**Memory not injecting**
- Confirm `MEMORY.md` exists at the correct project key path
- Run `echo '{"prompt":"test","cwd":"'$PWD'"}' | node ~/.claude/hooks/context.cjs`
- Output should include `continue: true`

**context.cjs injects but facts are wrong**
- Check your project key: the directory name must match exactly
- `ls ~/.claude/projects/` to see what keys exist

**Hooks blocking legitimate commands**
- critic-evaluator blocks at danger score ≥7
- Check which patterns triggered in the block message
- For intentional high-risk commands: ask Claude to confirm before running

---

## Adding facts to project memory

In `~/.claude/projects/<key>/memory/MEMORY.md`, add bullet points:

```markdown
# Project Memory

- IMPORTANT: Always use TypeScript strict mode
- API base URL is https://api.myproject.com/v2
- Auth uses JWT stored in httpOnly cookies
- Database is Postgres 15, ORM is Prisma
```

Lines with `IMPORTANT:` are injected first and get priority slots. Regular lines fill the remaining slots. Max 200 lines total.

---

## File locations reference

| File | Purpose |
|---|---|
| `~/.claude/hooks/*.cjs` | Hook scripts |
| `~/.claude/settings.json` | Hook registration |
| `~/.claude/memory/*.md` | Global knowledge files |
| `~/.claude/projects/<key>/memory/MEMORY.md` | Project memory |
| `~/.claude/session-learnings.md` | Live session capture |
| `~/.claude/afk-queue.md` | AFK task queue |
| `~/.claude/afk-report.md` | AFK results report |
| `.claude/compaction-snapshots/` | Pre-compact state saves |
| `.claude/session-logs/` | Session activity logs |
