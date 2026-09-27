// Cursor plan-usage provider (task #6).
//
// POST {} (Connect-RPC: JSON body, Connect-Protocol-Version: 1) to
// https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage.
// Read-only; does NOT consume quota.
//
// Only Cursor's actual auto and API usage bars are quota windows. Their reset
// comes from billingCycleEnd; plan/spend totals are not usage bars.
// On 401: refresh once (if a refresh token exists) and retry once.
// Auth/network errors => unknown, never "limited".

import type { SourceStatus, UsageWindow, WindowState } from "../types.ts";
import { deriveAvailability, unknownSource } from "../types.ts";
import { refreshCursorToken } from "../cursor-auth.ts";

const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const TIMEOUT_MS = 15_000;

interface RawPlanUsage {
  autoPercentUsed?: unknown;
  apiPercentUsed?: unknown;
}

type RawCursorPayload = {
  enabled?: unknown;
  planUsage?: RawPlanUsage | null;
  billingCycleEnd?: unknown;
} | null;

/** Coerce a raw field to a finite number; null when absent or invalid. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Clamp a percent into [0,100]; returns null when not a finite number. */
function normalizePercent(value: unknown): number | null {
  const n = toNumber(value);
  if (n === null) return null;
  return Math.min(100, Math.max(0, n));
}

/** Parse billingCycleEnd (ISO string or epoch seconds) to ISO; null when invalid. */
function normalizeResetsAt(value: unknown): string | null {
  if (typeof value === "string") {
    const t = new Date(value).getTime();
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const t = value < 1e12 ? value * 1000 : value; // heuristic: seconds vs ms
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/** A window at 100% used is exhausted; the provider does not report an explicit state. */
function stateFor(percent: number): WindowState {
  return percent >= 100 ? "rate-limited" : "ok";
}

/** Normalize a raw Cursor usage payload into UsageWindow[]. Drops windows without a computable percent. */
export function parseCursorUsage(payload: unknown): UsageWindow[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  if (root.enabled === false) return [];
  const planUsage = root.planUsage;
  if (!planUsage || typeof planUsage !== "object") return [];
  const pu = planUsage as RawPlanUsage;
  const resetsAt = normalizeResetsAt(root.billingCycleEnd);

  const windows: UsageWindow[] = [];

  const auto = normalizePercent(pu.autoPercentUsed);
  if (auto !== null) {
    windows.push({ name: "auto", usedPercent: auto, state: stateFor(auto), resetsAt });
  }

  const api = normalizePercent(pu.apiPercentUsed);
  if (api !== null) {
    windows.push({ name: "api", usedPercent: api, state: stateFor(api), resetsAt });
  }

  return windows;
}

export interface CursorProviderOptions {
  /** Bearer access token. When omitted, fetch() returns an unauthenticated unknown source. */
  accessToken?: string | null;
  /** Refresh token; enables the on-401 refresh-and-retry path. */
  refreshToken?: string | null;
  /** Called with the rotated token after a successful on-401 refresh (usually persists it). */
  onRotatedToken?: (accessToken: string, refreshToken: string | null) => void | Promise<void>;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/** Build the Cursor QuotaSource adapter. Never throws on auth/network errors. */
export function cursorProvider(opts: CursorProviderOptions = {}): { id: "cursor"; fetch(): Promise<SourceStatus> } {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  let accessToken = opts.accessToken ?? null;
  let refreshToken = opts.refreshToken ?? null;

  const post = (token: string): Promise<Response> =>
    fetchImpl(USAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  return {
    id: "cursor",
    async fetch(): Promise<SourceStatus> {
      if (!accessToken) return unknownSource("cursor", { error: "credential not found" });

      let response: Response;
      try {
        response = await post(accessToken);
      } catch {
        // Network failure / timeout — keep stale data, report unknown.
        return unknownSource("cursor", { authenticated: true, error: "request failed or timed out" });
      }

      if (response.status === 401) {
        // One refresh + one retry per fetch call.
        // ponytail: no proactive JWT-exp refresh (OpenChamber has it); an expired
        // token costs one extra 401 round-trip. Add when that proves noisy.
        if (!refreshToken) {
          return unknownSource("cursor", { authenticated: true, error: "authentication failed" });
        }
        const rotated = await refreshCursorToken(refreshToken, { fetchImpl });
        if (!rotated) {
          return unknownSource("cursor", { authenticated: true, error: "authentication failed (refresh unavailable)" });
        }
        accessToken = rotated.accessToken;
        refreshToken = rotated.refreshToken ?? refreshToken;
        try {
          await opts.onRotatedToken?.(accessToken, refreshToken);
        } catch {
          /* persistence is best effort */
        }
        try {
          response = await post(accessToken);
        } catch {
          return unknownSource("cursor", { authenticated: true, error: "request failed or timed out" });
        }
        if (response.status === 401) {
          return unknownSource("cursor", { authenticated: true, error: "authentication failed" });
        }
      }

      if (!response.ok) {
        return unknownSource("cursor", { authenticated: true, error: `usage API returned HTTP ${response.status}` });
      }

      let payload: RawCursorPayload;
      try {
        payload = (await response.json()) as RawCursorPayload;
      } catch {
        return unknownSource("cursor", { authenticated: true, error: "malformed JSON response" });
      }

      const root = (payload ?? {}) as Record<string, unknown>;
      // Mirrors OpenChamber: enabled===false or missing planUsage => no active subscription.
      if (root.enabled === false || !root.planUsage || typeof root.planUsage !== "object") {
        return unknownSource("cursor", { authenticated: true, error: "no active subscription" });
      }

      const windows = parseCursorUsage(payload);
      if (windows.length === 0) {
        return unknownSource("cursor", { authenticated: true, error: "usage data could not be parsed" });
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
