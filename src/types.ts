// Shared status contract for the OpenCode Usage plugin (schemaVersion 1).
//
// Rules:
// - Provider-reported windows are authoritative; per-model costs are estimates.
// - Absent credentials or stale data must never imply an available or exhausted pool.
// - No credential material (keys, tokens, headers) may appear anywhere in this schema.

export const SCHEMA_VERSION = 1 as const;

/** Account-wide availability of a provider's paid pool. */
export type Availability = "available" | "limited" | "unknown";

/** State of a single usage window as reported by the provider. */
export type WindowState = "ok" | "rate-limited" | "unknown";

/** One provider-reported usage window (e.g. rolling/5h, weekly, monthly). */
// ponytail: extends Record<string, JsonValue> so the type stays assignable to effect Schema.Json
// without casts at ctx.storage.set / RPC call sites.
interface UsageWindowBase extends Record<string, JsonValue> {
  /** Provider's own window name, e.g. "rolling", "weekly", "monthly". */
  name: string;
  /** Percent used, 0-100, as reported by the provider. null when unknown. */
  usedPercent: number | null;
  state: WindowState;
  /** ISO-8601 reset time, if the provider reports one. */
  resetsAt: string | null;
}

export type UsageWindow =
  | UsageWindowBase
  | (UsageWindowBase & { /** UTC day-of-month inferred from a usage drop to zero. */ resetDay: number })
  | (UsageWindowBase & { /** True when resetsAt is estimated rather than provider-reported. */ resetEstimated: true })
  | (UsageWindowBase & {
      /** UTC day-of-month inferred from a usage drop to zero. */
      resetDay: number;
      /** True when resetsAt is estimated rather than provider-reported. */
      resetEstimated: true;
    });

/** Normalized quota snapshot for one source (go | codex | cursor). */
// ponytail: extends Record<string, JsonValue> — see UsageWindow note.
export interface SourceStatus extends Record<string, JsonValue> {
  /** Whether a credential was found for this source. */
  authenticated: boolean;
  /** ISO-8601 time of the last successful poll. */
  checkedAt: string | null;
  /** True when data is older than the freshness bound and should not be trusted as current. */
  stale: boolean;
  /** Safe, human-readable error description. Never contains secrets. */
  error: string | null;
  /** Authoritative provider windows. Empty when unknown. */
  windows: UsageWindow[];
  /** Derived from all active windows; "unknown" on auth/network failure. */
  availability: Availability;
}

/** Public status shape with a derived time until all active limits reset. */
export interface StatusSnapshotSource extends SourceStatus {
  nextAvailableAt: string | null;
}

/** Earliest time the source can be fully available, or null if it cannot be inferred. */
export function deriveNextAvailableAt(windows: UsageWindow[], nowMs: number): string | null {
  const limited = windows.filter((window) => window.state === "rate-limited");
  if (limited.length === 0) return null;
  const resets = limited.map((window) => window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt));
  if (resets.some((reset) => !Number.isFinite(reset) || reset <= nowMs)) return null;
  return new Date(Math.max(...resets)).toISOString();
}

/** Per-model estimate for a Go model (estimate only — not a per-model quota). */
// ponytail: extends Record<string, JsonValue> — see UsageWindow note.
export interface GoModelEstimate extends Record<string, JsonValue> {
  /** Observed token usage for this model within the tracked period. */
  observedTokens: number;
  /** Estimated cost in USD, or null when pricing is unknown. */
  estimatedCostUSD: number | null;
  /** Where the price came from, e.g. "published 2026-09 docs" — provenance, not a URL secret. */
  priceProvenance: string | null;
  /** Free models bypass paid limits entirely. */
  free: boolean;
  /** Effective availability of the shared paid pool this model draws from. */
  effectiveAvailability: Availability;
}

/** Root versioned status document published via RPC and the status file. */
// ponytail: structural alias of effect's Schema.Json — TS won't assign an interface to a
// union without `extends`. This keeps ctx.storage.set / RPC output assignable without casts.
export type JsonValue = null | number | boolean | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface StatusSnapshot extends Record<string, JsonValue> {
  schemaVersion: typeof SCHEMA_VERSION;
  /** ISO-8601 time this snapshot was produced. */
  updatedAt: string;
  sources: {
    go: StatusSnapshotSource;
    codex: StatusSnapshotSource;
    cursor: StatusSnapshotSource;
  };
  /** Estimated per-model contribution for Go models. Estimates, not quotas. */
  models: {
    go: Record<string, GoModelEstimate>;
  };
}

/** A provider adapter normalizes raw endpoint data into a SourceStatus. */
export interface QuotaSource {
  id: "go" | "codex" | "cursor";
  /** Fetch and normalize. Must not throw on auth/network errors — return an unknown SourceStatus instead. */
  fetch(): Promise<SourceStatus>;
}

/** Shape of OpenCode V2 ctx.storage (subset we use). */
export interface StorageLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Freshness bounds. Poll cache ~60s; anything older is stale. */
export const POLL_CACHE_MS = 60_000;
export const STALE_AFTER_MS = 5 * 60_000;
/** Retry cadence for a credentialled source whose last poll failed or aged out. */
export const STALE_RETRY_MS = 15_000;

/** Build a SourceStatus that represents "we know nothing" without implying availability. */
export function unknownSource(id: string, opts?: { error?: string; authenticated?: boolean }): SourceStatus {
  void id;
  return {
    authenticated: opts?.authenticated ?? false,
    checkedAt: null,
    stale: true,
    error: opts?.error ?? null,
    windows: [],
    availability: "unknown",
  };
}

/** Derive availability from windows: any rate-limited window => limited; no windows => unknown. */
export function deriveAvailability(windows: UsageWindow[]): Availability {
  if (windows.length === 0) return "unknown";
  if (windows.some((w) => w.state === "rate-limited")) return "limited";
  if (windows.every((w) => w.state === "ok")) return "available";
  return "unknown";
}
