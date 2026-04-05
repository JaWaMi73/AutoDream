#!/usr/bin/env node
/**
 * Circuit Breaker Module
 * Prevents retry storms when external APIs fail.
 *
 * States:
 *   CLOSED  — Normal operation, requests pass through
 *   OPEN    — Tripped after N failures, all requests use fallback
 *   HALF_OPEN — After reset timeout, one test request allowed
 *
 * Usage as a module:
 *   const { CircuitBreaker } = require("./circuit-breaker.cjs");
 *   const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 30000 });
 *   const result = await breaker.call(riskyFn, fallbackFn);
 *
 * Usage as a CLI (check/reset state):
 *   node circuit-breaker.cjs --status
 *   node circuit-breaker.cjs --reset
 *
 * Usage as a PreToolUse hook (monitors Bash commands calling external APIs):
 *   Pipe hook JSON to stdin — blocks if circuit is open for that domain.
 */

const fs = require("fs");
const path = require("path");

// --- Persistent state file (survives across hook invocations) ---
const STATE_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || ".",
  ".claude",
  "circuit-breaker"
);
const STATE_FILE = path.join(STATE_DIR, "state.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch {}
  return { circuits: {} };
}

function saveState(state) {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// --- Circuit Breaker Class (for use as a module) ---
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 3;
    this.resetTimeout = options.resetTimeout || 30000; // 30 seconds
    this.name = options.name || "default";
    this.failures = 0;
    this.state = "CLOSED";
    this.lastFailureTime = null;
    this.totalTrips = 0;
  }

  async call(fn, fallback) {
    // Check if circuit should reset
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = "HALF_OPEN";
      } else {
        console.warn(
          `[CircuitBreaker:${this.name}] OPEN — using fallback (${this.failures} failures, resets in ${Math.round((this.resetTimeout - (Date.now() - this.lastFailureTime)) / 1000)}s)`
        );
        return typeof fallback === "function" ? fallback() : fallback;
      }
    }

    try {
      const result = await fn();
      // Success — reset
      if (this.state === "HALF_OPEN") {
        console.log(`[CircuitBreaker:${this.name}] Recovery successful — circuit CLOSED`);
      }
      this.failures = 0;
      this.state = "CLOSED";
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();

      if (this.failures >= this.failureThreshold) {
        this.state = "OPEN";
        this.totalTrips++;
        console.error(
          `[CircuitBreaker:${this.name}] ${this.failures} consecutive failures — circuit OPEN for ${this.resetTimeout / 1000}s (trip #${this.totalTrips})`
        );
      } else {
        console.warn(
          `[CircuitBreaker:${this.name}] Failure ${this.failures}/${this.failureThreshold}`
        );
      }

      if (typeof fallback === "function") return fallback();
      if (fallback !== undefined) return fallback;
      throw error;
    }
  }

  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      failureThreshold: this.failureThreshold,
      resetTimeout: this.resetTimeout,
      lastFailureTime: this.lastFailureTime,
      totalTrips: this.totalTrips,
      timeUntilReset:
        this.state === "OPEN" && this.lastFailureTime
          ? Math.max(0, this.resetTimeout - (Date.now() - this.lastFailureTime))
          : null,
    };
  }

  reset() {
    this.failures = 0;
    this.state = "CLOSED";
    this.lastFailureTime = null;
  }
}

// --- Domain detection for API calls ---
const API_DOMAINS = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.cohere.ai",
  "api.mistral.ai",
  "api.groq.com",
  "api.together.xyz",
  "api.replicate.com",
];

function extractDomain(command) {
  for (const domain of API_DOMAINS) {
    if (command.includes(domain)) return domain;
  }
  // Generic URL extraction
  const urlMatch = command.match(/https?:\/\/([^\/\s'"]+)/);
  return urlMatch ? urlMatch[1] : null;
}

// --- CLI Mode ---
function runAsCLI() {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    const state = loadState();
    console.log("Circuit Breaker Status");
    console.log("=".repeat(50));
    const circuits = Object.entries(state.circuits);
    if (circuits.length === 0) {
      console.log("No circuits tracked yet.");
    } else {
      for (const [domain, circuit] of circuits) {
        const resetIn =
          circuit.state === "OPEN" && circuit.lastFailureTime
            ? Math.max(0, Math.round((30000 - (Date.now() - circuit.lastFailureTime)) / 1000))
            : null;
        console.log(
          `  ${domain}: ${circuit.state} | failures: ${circuit.failures}/3 | trips: ${circuit.totalTrips || 0}${resetIn !== null ? ` | resets in ${resetIn}s` : ""}`
        );
      }
    }
    process.exit(0);
  }

  if (args.includes("--reset")) {
    const domain = args.find((a) => !a.startsWith("--"));
    const state = loadState();
    if (domain) {
      delete state.circuits[domain];
      saveState(state);
      console.log(`Circuit reset for ${domain}`);
    } else {
      saveState({ circuits: {} });
      console.log("All circuits reset.");
    }
    process.exit(0);
  }

  // Default: check if running as hook (stdin available)
  try {
    const stat = fs.fstatSync(0);
    if (stat.isFIFO() || !stat.isCharacterDevice()) {
      // Determine if PreToolUse or PostToolUse
      const peek = fs.readFileSync(0, "utf8");
      const data = JSON.parse(peek);
      if (data.hook_event_name === "PostToolUse" || data.tool_result !== undefined) {
        // Process inline — stdin already consumed
        const domain = extractDomain(data.tool_input?.command || "");
        if (!domain) process.exit(0);
        const state = loadState();
        if (!state.circuits[domain]) {
          state.circuits[domain] = { state: "CLOSED", failures: 0, lastFailureTime: null, totalTrips: 0 };
        }
        const circuit = state.circuits[domain];
        const resultStr = typeof data.tool_result === "string" ? data.tool_result : JSON.stringify(data.tool_result || "");
        const isFailure = /error|ECONNREFUSED|ETIMEDOUT|429|500|502|503|504|rate.limit|quota/i.test(resultStr);
        if (isFailure) {
          circuit.failures++;
          circuit.lastFailureTime = Date.now();
          if (circuit.failures >= 3) { circuit.state = "OPEN"; circuit.totalTrips = (circuit.totalTrips || 0) + 1; }
        } else {
          circuit.failures = 0;
          circuit.state = "CLOSED";
        }
        state.circuits[domain] = circuit;
        saveState(state);
        process.exit(0);
      } else {
        // PreToolUse hook
        const command = data.tool_input?.command || "";
        const domain = extractDomain(command);
        if (!domain) process.exit(0);
        const state = loadState();
        const circuit = state.circuits[domain] || { state: "CLOSED", failures: 0, lastFailureTime: null, totalTrips: 0 };
        if (circuit.state === "OPEN") {
          const elapsed = Date.now() - circuit.lastFailureTime;
          if (elapsed < 30000) {
            process.stdout.write(JSON.stringify({
              decision: "block",
              reason: `[CircuitBreaker] Circuit OPEN for ${domain} — ${circuit.failures} failures. Resets in ${Math.round((30000 - elapsed) / 1000)}s.`,
            }));
            process.exit(2);
          } else {
            circuit.state = "HALF_OPEN";
            state.circuits[domain] = circuit;
            saveState(state);
          }
        }
        process.exit(0);
      }
    }
  } catch {}

  // No stdin, no flags — show help
  console.log("Circuit Breaker for AI Coding Tools");
  console.log("");
  console.log("Usage:");
  console.log("  node circuit-breaker.cjs --status          Show all circuit states");
  console.log("  node circuit-breaker.cjs --reset           Reset all circuits");
  console.log("  node circuit-breaker.cjs --reset domain    Reset specific domain");
  console.log("");
  console.log("As a module:");
  console.log('  const { CircuitBreaker } = require("./circuit-breaker.cjs");');
  console.log("  const breaker = new CircuitBreaker({ failureThreshold: 3 });");
  console.log("  const result = await breaker.call(riskyFn, fallbackFn);");
}

// --- Exports ---
module.exports = { CircuitBreaker };

// Run if called directly
if (require.main === module) {
  runAsCLI();
}
