// OpenCode Go shared-limit provider (task #3).
//
// GET https://opencode.ai/zen/go/v1/usage with a bearer API key. The endpoint is
// read-only and does NOT consume quota. It reports account-wide shared windows:
// rolling (5h), weekly, monthly — each { percent, resetsAt }. Limits are shared
// across all paid Go models; free models bypass them entirely.
//
// Parsing mirrors OpenChamber's opencode-go.js: only finite percent + valid ISO
// resetsAt are kept; invalid values are dropped (never coerced to zero). 401/403
// => auth failed; other non-2xx => safe error; empty parse => unknown.

import type { SourceStatus, UsageWindow } from "../types.ts";
import { deriveAvailability, unknownSource } from "../types.ts";

const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const TIMEOUT_MS = 15_000;

/** Response window name -> our canonical window name. */
const WINDOWS_BY_API_KEY: Record<string, string> = {
  rolling: "rolling",
  weekly: "weekly",
  monthly: "monthly",
};

interface RawWindowEntry {
  percent?: unknown;
  resetsAt?: unknown;
}
type RawUsagePayload = { usage?: Record<string, RawWindowEntry | null> } | null;

/** Clamp a percent into [0,100]; returns null when not a finite number. */
function normalizePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/** Parse a raw resetsAt into an ISO string; null when absent or invalid. */
function normalizeResetsAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Normalize a raw usage payload into UsageWindow[]. Drops invalid entries. */
export function parseGoUsage(payload: unknown): UsageWindow[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const usage = root.usage;
  if (!usage || typeof usage !== "object") return [];
  const windows: UsageWindow[] = [];
  const usageMap = usage as Record<string, RawWindowEntry | null>;
  for (const [apiKey, name] of Object.entries(WINDOWS_BY_API_KEY)) {
    const entry = usageMap[apiKey];
    if (!entry || typeof entry !== "object") continue;
    const usedPercent = normalizePercent(entry.percent);
    if (usedPercent === null) continue; // never coerce invalid to zero
    const resetsAt = normalizeResetsAt(entry.resetsAt);
    // A fully-consumed window is exhausted by definition: the provider's own
    // reported percent (clamped to [0,100]) marks it rate-limited so the
    // status engine can gate re-polls until the reported reset (#11).
    windows.push({ name, usedPercent, state: usedPercent >= 100 ? "rate-limited" : "ok", resetsAt });
  }
  return windows;
}

export interface GoProviderOptions {
  /** Bearer API key. When omitted, fetch() returns an unauthenticated unknown source. */
  apiKey?: string | null;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/** Build the Go QuotaSource adapter. Never throws on auth/network errors. */
export function goProvider(opts: GoProviderOptions = {}): { id: "go"; fetch(): Promise<SourceStatus> } {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());

  return {
    id: "go",
    async fetch(): Promise<SourceStatus> {
      const apiKey = opts.apiKey ?? null;
      if (!apiKey) return unknownSource("go", { error: "credential not found" });

      let response: Response;
      try {
        response = await fetchImpl(GO_USAGE_URL, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
            "x-opencode-session": "openchamber-usage",
            "User-Agent": "OpenChamber quota provider",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        // Network failure / timeout — keep stale data, report unknown.
        return unknownSource("go", { authenticated: true, error: "request failed or timed out" });
      }

      if (response.status === 401 || response.status === 403) {
        return unknownSource("go", { authenticated: true, error: "authentication failed" });
      }
      if (!response.ok) {
        return unknownSource("go", { authenticated: true, error: `usage API returned HTTP ${response.status}` });
      }

      let payload: RawUsagePayload;
      try {
        payload = (await response.json()) as RawUsagePayload;
      } catch {
        return unknownSource("go", { authenticated: true, error: "malformed JSON response" });
      }

      const windows = parseGoUsage(payload);
      if (windows.length === 0) {
        return unknownSource("go", { authenticated: true, error: "usage data could not be parsed" });
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

/** Detect whether a Go model is free (bypasses paid limits).
 * ponytail: free detection relies on verified model metadata passed in by the caller
 * (#8 attribution owns the live model list). This helper just checks the flag.
 */
export function isFreeGoModel(modelId: string, freeIds: ReadonlySet<string>): boolean {
  return freeIds.has(modelId);
}
