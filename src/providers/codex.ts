// Codex / ChatGPT usage provider (task #4).
//
// GET https://chatgpt.com/backend-api/wham/usage with bearer OAuth access and an
// optional ChatGPT-Account-Id header. Read-only; does NOT consume quota.
//
// Response shape (mirrors OpenChamber codex.js):
//   { rate_limit: { primary_window: {...}, secondary_window: {...} },
//     credits?: { balance, unlimited }, spend_control?: { individual_limit: {...} } }
// Each window: { limit_window_seconds, used_percent, reset_at }.
//
// Window labels come from the ACTUAL limit_window_seconds — a "primary"/"secondary"
// label alone does not establish a 5h or weekly duration. No monthly cap is invented.
// Auth/network errors => unknown, never "limited".

import type { SourceStatus, UsageWindow } from "../types.ts";
import { deriveAvailability, unknownSource } from "../types.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TIMEOUT_MS = 15_000;

interface RawCodexWindow {
  limit_window_seconds?: unknown;
  used_percent?: unknown;
  reset_at?: unknown;
}
type RawCodexPayload = {
  rate_limit?: { primary_window?: RawCodexWindow | null; secondary_window?: RawCodexWindow | null } | null;
  credits?: { balance?: unknown; unlimited?: unknown } | null;
  spend_control?: { individual_limit?: { used?: unknown; limit?: unknown; used_percent?: unknown } | null } | null;
} | null;

/** Clamp a percent into [0,100]; returns null when not a finite number. */
function normalizePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/** Parse a raw reset_at into an ISO string; null when absent or invalid. */
function normalizeResetAt(value: unknown): string | null {
  if (typeof value === "string") {
    const t = new Date(value).getTime();
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  // Some payloads use epoch seconds.
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const t = value < 1e12 ? value * 1000 : value; // heuristic: seconds vs ms
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/** Derive a human-readable window label from actual seconds. Never invents durations. */
export function resolveWindowLabel(windowSeconds: number | null): string {
  if (windowSeconds === null || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return "unknown";
  // Check days first so 7d isn't labeled "168h".
  const days = windowSeconds / 86400;
  if (days >= 1 && Math.abs(days - Math.round(days)) < 0.01) return `${Math.round(days)}d`;
  const hours = windowSeconds / 3600;
  if (hours >= 1 && Math.abs(hours - Math.round(hours)) < 0.01) return `${Math.round(hours)}h`;
  return `${Math.round(windowSeconds / 60)}m`;
}

/** Normalize a raw Codex payload into UsageWindow[]. Drops windows without a valid percent. */
export function parseCodexUsage(payload: unknown): UsageWindow[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const rateLimit = root.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") return [];
  const rl = rateLimit as { primary_window?: RawCodexWindow | null; secondary_window?: RawCodexWindow | null };

  const windows: UsageWindow[] = [];
  const entries: Array<[string, RawCodexWindow | null | undefined]> = [
    ["primary", rl.primary_window],
    ["secondary", rl.secondary_window],
  ];

  for (const [slot, entry] of entries) {
    if (!entry || typeof entry !== "object") continue;
    const usedPercent = normalizePercent(entry.used_percent);
    if (usedPercent === null) continue; // never coerce invalid to zero
    const seconds = typeof entry.limit_window_seconds === "number" && Number.isFinite(entry.limit_window_seconds)
      ? entry.limit_window_seconds
      : null;
    const label = resolveWindowLabel(seconds);
    const resetsAt = normalizeResetAt(entry.reset_at);
    windows.push({ name: `${slot}_${label}`, usedPercent, state: "ok", resetsAt });
  }
  return windows;
}

export interface CodexProviderOptions {
  /** Bearer OAuth access token. When omitted, fetch() returns an unauthenticated unknown source. */
  accessToken?: string | null;
  /** Optional ChatGPT-Account-Id header value. */
  accountId?: string | null;
  /**
   * Re-resolve the session credential after a 401 (the token expires while the
   * plugin runs). Called at most once per fetch, and only when rejected.
   */
  refreshCredential?: () => { access: string; accountId: string | null } | null;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/** Build the Codex QuotaSource adapter. Never throws on auth/network errors. */
export function codexProvider(opts: CodexProviderOptions = {}): { id: "codex"; fetch(): Promise<SourceStatus> } {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());

  const send = (accessToken: string, accountId: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    return fetchImpl(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  };

  return {
    id: "codex",
    async fetch(): Promise<SourceStatus> {
      let accessToken = opts.accessToken ?? null;
      if (!accessToken) return unknownSource("codex", { error: "credential not found" });
      let accountId = opts.accountId ?? null;

      let response: Response;
      try {
        response = await send(accessToken, accountId);
      } catch {
        return unknownSource("codex", { authenticated: true, error: "request failed or timed out" });
      }

      // The session token expires while the plugin runs: re-resolve once, retry
      // once, so a long-lived process does not sit on an expired token forever.
      if (response.status === 401) {
        const renewed = opts.refreshCredential?.() ?? null;
        if (renewed && renewed.access !== accessToken) {
          accessToken = renewed.access;
          accountId = renewed.accountId;
          try {
            response = await send(accessToken, accountId);
          } catch {
            return unknownSource("codex", { authenticated: true, error: "request failed or timed out" });
          }
        }
      }

      if (response.status === 401) {
        return unknownSource("codex", { authenticated: true, error: "authentication failed (session expired)" });
      }
      if (!response.ok) {
        return unknownSource("codex", { authenticated: true, error: `usage API returned HTTP ${response.status}` });
      }

      let payload: RawCodexPayload;
      try {
        payload = (await response.json()) as RawCodexPayload;
      } catch {
        return unknownSource("codex", { authenticated: true, error: "malformed JSON response" });
      }

      const windows = parseCodexUsage(payload);
      if (windows.length === 0) {
        return unknownSource("codex", { authenticated: true, error: "usage data could not be parsed" });
      }

      return {
        authenticated: true,
        checkedAt: new Date(now()).toISOString(),
        stale: false,
        error: null,
        windows,
        availability: deriveAvailability(windows),
      };
    },
  };
}
