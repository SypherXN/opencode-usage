// Claude subscription usage provider (mirrors OpenChamber's claude quota provider).
//
// GET https://api.anthropic.com/api/oauth/usage with Claude Code's OAuth token.
// Read-only; does not consume quota. The endpoint is undocumented and may change.
// Payload: { five_hour: {utilization (percent), resets_at (ISO)}, seven_day, seven_day_opus,
// seven_day_sonnet } — entries may be null. Failures => unknown, never "limited".

import type { SourceStatus, UsageWindow } from "../types.ts";
import { deriveAvailability, unknownSource } from "../types.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 15_000;
/** Matches OpenChamber's usage-tab cadence (3 min) so the two share the token's budget. */
export const CLAUDE_POLL_MS = 3 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000; // OpenChamber's default; Retry-After may extend it
const MAX_COOLDOWN_MS = 60 * 60_000;
const FAILURE_COOLDOWN_MS = 60_000;
const FIELDS: Array<[string, string]> = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_opus", "7d_opus"],
  ["seven_day_sonnet", "7d_sonnet"],
];

export function parseClaudeUsage(payload: unknown): UsageWindow[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  for (const [field, name] of FIELDS) {
    const w = root[field] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!w || typeof w !== "object" || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    const usedPercent = Math.min(100, Math.max(0, w.utilization));
    const t = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    windows.push({
      name,
      usedPercent,
      state: usedPercent >= 100 ? "rate-limited" : "ok",
      resetsAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
    });
  }
  return windows;
}

export interface ClaudeProviderOptions {
  /** Re-reads the token on each fetch (Claude Code rotates it). */
  resolveToken: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function claudeProvider(opts: ClaudeProviderOptions): { id: "claude-agent"; fetch(): Promise<SourceStatus> } {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  // The endpoint is shared with OpenChamber (same token). After a failure, stay off
  // it: the engine's 15s unhealthy retry would otherwise hammer a limited endpoint.
  let cooldownUntil = 0;
  return {
    id: "claude-agent",
    async fetch(): Promise<SourceStatus> {
      const token = opts.resolveToken();
      if (!token) return unknownSource("claude-agent", { error: "Claude Code credential not found" });
      if (now() < cooldownUntil) {
        return unknownSource("claude-agent", { authenticated: true, error: "cooling down after a failed or rate-limited request" });
      }
      let response: Response;
      try {
        response = await fetchImpl(USAGE_URL, {
          headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        cooldownUntil = now() + FAILURE_COOLDOWN_MS;
        return unknownSource("claude-agent", { authenticated: true, error: "request failed or timed out" });
      }
      if (response.status === 429) {
        const secs = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(secs) && secs > 0 ? secs * 1000 : RATE_LIMIT_COOLDOWN_MS;
        cooldownUntil = now() + Math.min(MAX_COOLDOWN_MS, Math.max(RATE_LIMIT_COOLDOWN_MS, wait));
        return unknownSource("claude-agent", { authenticated: true, error: "usage API rate limited (HTTP 429)" });
      }
      if (!response.ok) cooldownUntil = now() + FAILURE_COOLDOWN_MS;
      if (response.status === 401 || response.status === 403) {
        return unknownSource("claude-agent", { authenticated: true, error: "authentication failed (token expired)" });
      }
      if (!response.ok) {
        return unknownSource("claude-agent", { authenticated: true, error: `usage API returned HTTP ${response.status}` });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return unknownSource("claude-agent", { authenticated: true, error: "malformed JSON response" });
      }
      const windows = parseClaudeUsage(payload);
      if (windows.length === 0) {
        return unknownSource("claude-agent", { authenticated: true, error: "usage data could not be parsed" });
      }
      return {
        authenticated: true,
        checkedAt: new Date(now()).toISOString(),
        stale: false,
        error: null,
        windows,
        availability: deriveAvailability(windows),
        plan: null,
      };
    },
  };
}
