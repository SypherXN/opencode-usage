// Official Claude Code client probe. Runs the installed CLI in an isolated,
// throwaway directory and reads only validated quota events from its stream.
// No HTTP client, no raw response text, no credential persisted.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageWindow } from "../types.ts";

/** Child retries are disabled; this is only the outer deadline. */
export const CLAUDE_PROBE_TIMEOUT_MS = 30_000;
const CLAUDE_PROBE_OUTPUT_LIMIT = 1024 * 1024;
const CLAUDE_PROBE_PROMPT = "Reply with OK only.";
const CLAUDE_PROBE_MODEL = "claude-haiku-5-5";

export type ClaudeProbeSpawn = typeof spawn;

/** Fixed, safe errors. Raw stderr/stdout is never exposed. */
export const CLAUDE_PROBE_ERRORS = {
  launch: "probe CLI failed to launch",
  timeout: "probe CLI timed out",
  output: "probe CLI output limit exceeded",
  exit: "probe CLI exited unsuccessfully",
  noData: "probe CLI returned no usage data",
} as const;

export type ClaudeProbeOutcome = { windows: UsageWindow[] } | { error: string };

export interface RunClaudeProbeOptions {
  token: string;
  spawnImpl?: ClaudeProbeSpawn;
  /** Test-only timeout override. Production uses the fixed 30 s deadline. */
  timeoutMs?: number;
  /** Test-only temp root override; production uses the platform temp root. */
  tempRoot?: string;
}

const WINDOW_NAMES: Array<[string, string]> = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
];

function probeStatus(value: unknown): "allowed" | "allowed_warning" | "rejected" | null {
  return value === "allowed" || value === "allowed_warning" || value === "rejected" ? value : null;
}

function probeReset(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value * 1000 <= 8.64e15) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

function probeWindow(name: string, info: unknown): UsageWindow | null {
  const w = info as { status?: unknown; utilization?: unknown; resetsAt?: unknown } | null | undefined;
  const status = probeStatus(w?.status);
  const utilization = typeof w?.utilization === "number" && Number.isFinite(w.utilization) &&
      w.utilization >= 0 && w.utilization <= 1
    ? w.utilization
    : null;
  if (status === null && utilization === null) return null;
  return {
    name,
    usedPercent: utilization === null ? null : utilization * 100,
    state: status === "rejected" ? "rate-limited" : status === null ? "unknown" : "ok",
    resetsAt: probeReset(w?.resetsAt),
  };
}

function tempRoot(): string {
  const base = process.env.TEMP || process.env.TMP || tmpdir();
  // Windows' approved scratch area; elsewhere the platform temp directory.
  return process.platform === "win32" ? path.join(base, "opencode") : tmpdir();
}

function probeEnv(token: string, configDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_USE_")) delete env[key];
  }
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_BASE_URL"]) {
    delete env[key];
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "16";
  env.CLAUDE_CODE_MAX_RETRIES = "0";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

/**
 * Run the official client once with tools, MCP, hooks and retries disabled.
 * The process gets a fresh empty config dir and a working dir of its own.
 */
export function runClaudeProbe(opts: RunClaudeProbeOptions): Promise<ClaudeProbeOutcome> {
  const spawnFn = opts.spawnImpl ?? spawn;
  const timeoutMs = opts.timeoutMs ?? CLAUDE_PROBE_TIMEOUT_MS;
  let dir: string;
  let configDir: string;
  try {
    const base = opts.tempRoot ?? tempRoot();
    mkdirSync(base, { recursive: true });
    dir = mkdtempSync(path.join(base, "claude-probe-"));
    configDir = path.join(dir, "config");
    mkdirSync(configDir);
  } catch {
    return Promise.resolve({ error: CLAUDE_PROBE_ERRORS.launch });
  }

  const args = [
    "-p", CLAUDE_PROBE_PROMPT,
    "--model", CLAUDE_PROBE_MODEL,
    "--safe-mode",
    "--no-session-persistence",
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "1",
    "--tools", "",
    "--permission-prompts", "none",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--settings", '{"disableAllHooks":true}',
  ];

  return new Promise<ClaudeProbeOutcome>((resolve) => {
    let settled = false;
    let total = 0;
    let pending = "";
    let timedOut = false;
    let outputLimited = false;
    let launchFailed = false;
    let resultError = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const windows = new Map<string, UsageWindow>();

    const finish = (outcome: ClaudeProbeOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* scratch dir only */
      }
      resolve(outcome);
    };

    const frame = (line: string): void => {
      let x: unknown;
      try {
        x = JSON.parse(line);
      } catch {
        return;
      }
      if (!x || typeof x !== "object") return;
      const event = x as {
        type?: unknown;
        is_error?: unknown;
        rate_limit_info?: { unifiedWindows?: Record<string, unknown> };
      };
      if (event.type === "result" && event.is_error === true) resultError = true;
      if (event.type !== "rate_limit_event") return;
      for (const [field, name] of WINDOW_NAMES) {
        const window = probeWindow(name, event.rate_limit_info?.unifiedWindows?.[field]);
        if (window) windows.set(name, window);
      }
    };

    let child: ReturnType<ClaudeProbeSpawn>;
    try {
      child = spawnFn(process.platform === "win32" ? "claude.exe" : "claude", args, {
        cwd: dir,
        env: probeEnv(opts.token, configDir),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch {
      finish({ error: CLAUDE_PROBE_ERRORS.launch });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputLimited) return;
      total += chunk.length;
      if (total > CLAUDE_PROBE_OUTPUT_LIMIT) {
        outputLimited = true;
        child.kill();
        return;
      }
      pending += chunk.toString("utf8");
      let i: number;
      while ((i = pending.indexOf("\n")) >= 0) {
        frame(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
    });
    child.stderr?.on("data", () => {
      /* drained and discarded */
    });
    child.on("error", () => {
      launchFailed = true;
    });
    child.on("close", (code: number | null) => {
      if (pending) frame(pending);
      if (timedOut) return finish({ error: CLAUDE_PROBE_ERRORS.timeout });
      if (outputLimited) return finish({ error: CLAUDE_PROBE_ERRORS.output });
      if (launchFailed) return finish({ error: CLAUDE_PROBE_ERRORS.launch });
      if (resultError || code !== 0) return finish({ error: CLAUDE_PROBE_ERRORS.exit });
      if (windows.size === 0) return finish({ error: CLAUDE_PROBE_ERRORS.noData });
      finish({ windows: [...windows.values()] });
    });
  });
}
