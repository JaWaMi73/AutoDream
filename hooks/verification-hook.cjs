#!/usr/bin/env node
/**
 * Verification Hook — PostToolUse on Write/Edit
 * After code-generating tool calls, checks if the output is valid.
 * Runs linters/compilers based on file extension.
 * Injects fix guidance if errors are found.
 *
 * Exit 0 = allow (with optional context injection)
 */

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// Map file extensions to verification commands
const VERIFIERS = {
  ".js": { cmd: "node --check", name: "Node.js syntax" },
  ".cjs": { cmd: "node --check", name: "Node.js syntax" },
  ".mjs": { cmd: "node --check", name: "Node.js syntax" },
  ".json": { cmd: null, name: "JSON parse", custom: "json" },
  ".py": { cmd: "python -m py_compile", name: "Python syntax" },
  ".ts": { cmd: null, name: "TypeScript", custom: "ts" },
  ".tsx": { cmd: null, name: "TypeScript", custom: "ts" },
  ".sh": { cmd: "bash -n", name: "Bash syntax" },
  ".yaml": { cmd: null, name: "YAML parse", custom: "yaml" },
  ".yml": { cmd: null, name: "YAML parse", custom: "yaml" },
};

function getFilePath(hookData) {
  const input = hookData.tool_input || {};
  return input.file_path || input.path || null;
}

function verifyJSON(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    JSON.parse(content);
    return null;
  } catch (e) {
    return `JSON parse error: ${e.message}`;
  }
}

function verifyTypeScript(filePath) {
  // Skip npx (too slow) — only verify if tsc is locally installed
  try {
    execFileSync("tsc", ["--version"], { timeout: 3000, stdio: "pipe" });
  } catch {
    return null; // tsc not available, skip silently
  }
  try {
    execFileSync("tsc", ["--noEmit", "--allowJs", "--skipLibCheck", filePath], {
      encoding: "utf8",
      timeout: 15000,
      stdio: "pipe",
    });
    return null;
  } catch (e) {
    if (e.stdout) return e.stdout.slice(0, 500);
    return null;
  }
}

function verifyYAML(filePath) {
  try {
    // Try node-based YAML parse
    const content = fs.readFileSync(filePath, "utf8");
    // Basic YAML validation: check for tab indentation (common error)
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/^\t/)) {
        return `YAML error line ${i + 1}: tabs not allowed for indentation`;
      }
    }
    return null;
  } catch (e) {
    return `YAML error: ${e.message}`;
  }
}

function verifyFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const verifier = VERIFIERS[ext];
  if (!verifier) return null; // No verifier for this extension

  // Custom verifiers
  if (verifier.custom === "json") return verifyJSON(filePath);
  if (verifier.custom === "ts") return verifyTypeScript(filePath);
  if (verifier.custom === "yaml") return verifyYAML(filePath);

  // Command-based verifiers — use execFileSync to avoid shell injection
  if (verifier.cmd) {
    const parts = verifier.cmd.split(" ");
    const cmd = parts[0];
    const cmdArgs = [...parts.slice(1), filePath];
    try {
      execFileSync(cmd, cmdArgs, {
        encoding: "utf8",
        timeout: 10000,
        stdio: "pipe",
      });
      return null; // No errors
    } catch (e) {
      const output = (e.stdout || e.stderr || e.message || "").slice(0, 500);
      return `${verifier.name} error:\n${output}`;
    }
  }

  return null;
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

  // Only run on PostToolUse for Write/Edit
  const toolName = hookData.tool_name || "";
  if (!["Write", "Edit"].includes(toolName)) process.exit(0);

  const filePath = getFilePath(hookData);
  if (!filePath) process.exit(0);

  // Check file exists
  if (!fs.existsSync(filePath)) process.exit(0);

  // Verify
  const error = verifyFile(filePath);

  if (error) {
    const output = {
      systemMessage:
        `[VERIFICATION] The file you just wrote/edited has errors:\n` +
        `File: ${filePath}\n${error}\n\n` +
        `Fix these errors before moving on. Do NOT skip this.`,
    };
    process.stdout.write(JSON.stringify(output));
  }

  process.exit(0);
}

main();
