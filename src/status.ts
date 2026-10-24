// Read-through quota status engine (task #7).
//
// The engine is the SINGLE OWNER of upstream polling. Every consumer (RPC,
// status file, other agents/tools) reads through this cache; readers never
// hit the Go/Codex/Cursor usage endpoints directly.
//
// Rules:
// - A source's cache is fresh for ttlMs (~60s). N concurrent readers within
//   the TTL coalesce into exactly one upstream fetch (in-flight promise).
// - An unhealthy source (credentialled, last attempt failed) is retried every
//   staleRetryMs (~15s) instead of the cache TTL, so a transient auth/network
//   blip clears quickly. A source capped until a known reset keeps the TTL, as
//   do healthy sources, so the shorter loop tick costs them no extra polls.
// - A rate-limited window does not suppress later polls. Provider reset times
//   can arrive early, so the next TTL rechecks the usage endpoint instead of
//   waiting for resetsAt. Availability still comes from the windows that poll
//   returns, so a monthly cap stays limited after a 5h window clears.
// - Auth/network failures keep the last timestamped windows with availability
//   "unknown" and a safe error — a failure alone never marks the source stale;
//   only age does (no successful poll for STALE_AFTER_MS). Unknown/stale data
//   never claims current availability or exhaustion.
// - refresh() (quota-denial trigger) performs one immediate read-only usage
//   poll, bypassing the TTL.
// - The background loop polls read-only usage endpoints only. No inference
//   probes, no model switching, no fallback resets.

import {
  POLL_CACHE_MS,
  SCHEMA_VERSION,
  STALE_AFTER_MS,
  STALE_RETRY_MS,
  deriveAvailability,
  deriveNextAvailableAt,
  unknownSource,
} from "./types.ts";
import type {
  GoModelEstimate,
  QuotaSource,
  SourceStatus,
  StatusSnapshotSource,
  StatusSnapshot,
  StorageLike,
  UsageWindow,
} from "./types.ts";

export type SourceId = "go" | "codex" | "cursor";

const SOURCE_IDS: readonly SourceId[] = ["go", "codex", "cursor"];

/** Durable key for the last snapshot (success or last-known on failure). */
export const SNAPSHOT_KEY = "status/snapshot";

export interface StatusEngineOptions {
  /** Provider adapters. Missing sources are unconfigured (unknown, never polled). */
  providers?: Partial<Record<SourceId, QuotaSource>>;
  /** Durable storage (OpenCode ctx.storage). Optional — the engine works in-memory. */
  storage?: StorageLike;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Cache TTL / background poll interval. Defaults to POLL_CACHE_MS (~60s). */
  ttlMs?: number;
  /** One-time estimated Cursor reset date, superseded by provider or observed resets. */
  cursorResetAt?: string;
}

interface CacheEntry {
  status: SourceStatus;
  /** ms of the last successful poll; null when never polled successfully. */
  checkedAtMs: number | null;
  /** ms of the last poll attempt (success or failure); null before the first. */
  attemptedAtMs: number | null;
  /** True when the most recent poll attempt succeeded. */
  verified: boolean;
  /** In-flight coalesced poll, if any. */
  inFlight?: Promise<SourceStatus>;
}

/** True when a window is rate-limited until a future, provider-reported reset. */
function cappedUntilKnownReset(windows: UsageWindow[], nowMs: number): boolean {
  return windows.some((w) => {
    if (w.state !== "rate-limited" || w.resetsAt === null) return false;
    const t = Date.parse(w.resetsAt);
    return Number.isFinite(t) && t > nowMs;
  });
}

function nextMonthlyReset(nowMs: number, day: number): string {
  const now = new Date(nowMs);
  const atUtcDay = (year: number, month: number) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(day, lastDay));
  };
  let reset = atUtcDay(now.getUTCFullYear(), now.getUTCMonth());
  if (reset <= nowMs) reset = atUtcDay(now.getUTCFullYear(), now.getUTCMonth() + 1);
  return new Date(reset).toISOString();
}

function trackCursorResetDays(
  previous: SourceStatus,
  fresh: SourceStatus,
  initialResetAt?: string,
  detectDrop = true,
): SourceStatus {
  const previousByName = new Map(previous.windows.map((window) => [window.name, window]));
  const checkedAt = Date.parse(fresh.checkedAt!);
  const observedDay = new Date(checkedAt).getUTCDate();
  const initialResetMs = initialResetAt ? Date.parse(initialResetAt) : Number.NaN;
  const windows = fresh.windows.map((window) => {
    const prior = previousByName.get(window.name);
    const priorResetDay = prior && typeof prior.resetDay === "number" ? prior.resetDay : undefined;
    const observedDrop = detectDrop && prior?.usedPercent !== null && prior?.usedPercent !== undefined &&
      prior.usedPercent > 0 && window.usedPercent === 0
    const resetDay = observedDrop ? observedDay : priorResetDay;

    // ponytail: observed UTC day is a monthly heuristic; provider and user dates win.
    if (window.resetsAt !== null) return { ...window, ...(resetDay === undefined ? {} : { resetDay }) };
    if (resetDay === undefined && Number.isFinite(initialResetMs) && initialResetMs > checkedAt) {
      return {
        ...window,
        ...(resetDay === undefined ? {} : { resetDay }),
        resetsAt: new Date(initialResetMs).toISOString(),
        resetEstimated: true as const,
      };
    }
    if (resetDay === undefined) return window;
    return { ...window, resetDay, resetsAt: nextMonthlyReset(checkedAt, resetDay), resetEstimated: true };
  });
  return { ...fresh, windows, availability: deriveAvailability(windows) };
}

export class StatusEngine {
  private readonly providers: Partial<Record<SourceId, QuotaSource>>;
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cursorResetAt?: string;
  private readonly entries: Record<SourceId, CacheEntry>;
  private estimator: (go: SourceStatus) => Record<string, GoModelEstimate> = () => ({});
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: StatusEngineOptions = {}) {
    this.providers = opts.providers ?? {};
    this.storage = opts.storage ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? POLL_CACHE_MS;
    this.cursorResetAt = opts.cursorResetAt;
    const entry = (id: SourceId): CacheEntry => ({
      status: this.providers[id]
        ? unknownSource(id)
        : unknownSource(id, { error: "source not configured" }),
      checkedAtMs: null,
      attemptedAtMs: null,
      verified: false,
    });
    this.entries = { go: entry("go"), codex: entry("codex"), cursor: entry("cursor") };
  }

  /** Load the last persisted snapshot into the cache. Idempotent. */
  async hydrate(): Promise<void> {
    if (!this.storage) return;
    let raw: unknown;
    try {
      raw = await this.storage.get(SNAPSHOT_KEY);
    } catch {
      return;
    }
    const snap = (raw ?? {}) as Partial<StatusSnapshot>;
    for (const id of SOURCE_IDS) {
      const src = snap.sources?.[id];
      if (!src || !src.checkedAt) continue;
      const t = Date.parse(src.checkedAt);
      if (!Number.isFinite(t)) continue;
      // attemptedAtMs stays null: this process has not polled yet, so a
      // hydrated-but-unverified source is retried on the first tick.
      this.entries[id] = { status: { ...src }, checkedAtMs: t, attemptedAtMs: null, verified: !src.stale };
    }
  }

  /** Read-through: serves the fresh cache, otherwise one coalesced upstream poll. */
  read(id: SourceId): Promise<SourceStatus> {
    return this.poll(id, false);
  }

  /**
   * Immediate safe read-only usage poll (quota-denial trigger). Bypasses the
   * TTL; still coalesces with any in-flight poll.
   */
  refresh(id: SourceId): Promise<SourceStatus> {
    return this.poll(id, true);
  }

  /** All sources in one pass (may trigger coalesced polls for stale ones). */
  readAll(): Promise<Record<SourceId, SourceStatus>> {
    return Promise.all(SOURCE_IDS.map((id) => this.poll(id, false))).then(
      ([go, codex, cursor]) => ({ go, codex, cursor }),
    );
  }

  /** Full versioned document for consumers (RPC / status file). */
  async snapshot(): Promise<StatusSnapshot> {
    await Promise.all(SOURCE_IDS.map((id) => this.poll(id, false)));
    return this.snapshotFromCache();
  }

  /** #8 registers per-model Go estimates here (estimates, not quotas). */
  setModelEstimator(fn: (go: SourceStatus) => Record<string, GoModelEstimate>): void {
    this.estimator = fn;
  }

  private snapshotFromCache(): StatusSnapshot {
    let models: Record<string, GoModelEstimate>;
    try {
      models = this.estimator(this.cached("go"));
    } catch {
      models = {};
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date(this.now()).toISOString(),
      sources: {
        go: this.cached("go"),
        codex: this.cached("codex"),
        cursor: this.cached("cursor"),
      },
      models: { go: models },
    };
  }

  private cached(id: SourceId): StatusSnapshotSource {
    const e = this.entries[id];
    const stale = this.isStale(e);
    // Stale data must never imply a current available or exhausted pool.
    return {
      ...e.status,
      stale,
      availability: stale ? "unknown" : e.status.availability,
      nextAvailableAt: deriveNextAvailableAt(e.status.windows, this.now()),
    };
  }

  // Freshness is AGE, not the last attempt's outcome: a failed poll keeps
  // serving last-known windows with availability "unknown" and an error, and
  // only ages into stale once no successful poll has landed for STALE_AFTER_MS.
  private isStale(e: CacheEntry): boolean {
    if (e.checkedAtMs === null) return true;
    return this.now() - e.checkedAtMs > STALE_AFTER_MS;
  }

  private shouldPoll(id: SourceId): boolean {
    const e = this.entries[id];
    if (!this.providers[id]) return false;
    const nowMs = this.now();
    // Unhealthy (last attempt failed) and not known to be capped: retry from the
    // last ATTEMPT, faster than the cache TTL, so a blip clears quickly. A
    // capped source keeps the normal cadence — its state is already known.
    // (Age alone cannot decide this: an unhealthy source's last SUCCESS is
    // always older than the TTL, which is why attemptedAtMs exists.)
    if (!e.verified && e.status.authenticated) {
      const throttle = cappedUntilKnownReset(e.status.windows, nowMs) ? this.ttlMs : STALE_RETRY_MS;
      return this.elapsed(e.attemptedAtMs, nowMs) >= throttle;
    }
    return this.elapsed(e.checkedAtMs, nowMs) >= this.ttlMs;
  }

  private elapsed(fromMs: number | null, nowMs: number): number {
    return fromMs === null ? Number.POSITIVE_INFINITY : nowMs - fromMs;
  }

  private poll(id: SourceId, force: boolean): Promise<SourceStatus> {
    const e = this.entries[id];
    const provider = this.providers[id];
    if (!provider) return Promise.resolve(this.cached(id));
    if (e.inFlight) return e.inFlight; // coalesce: N readers, one upstream fetch
    if (!force && !this.shouldPoll(id)) return Promise.resolve(this.cached(id));

    const run = (async (): Promise<SourceStatus> => {
      let fresh: SourceStatus;
      try {
        fresh = await provider.fetch();
      } catch {
        // Providers must not throw, but stay safe anyway.
        fresh = unknownSource(id, { authenticated: e.status.authenticated, error: "request failed or timed out" });
      }
      if (fresh.checkedAt) {
        // Success — availability is re-derived from ALL reported windows.
        const observed = id === "cursor"
          ? trackCursorResetDays(e.status, fresh, this.cursorResetAt, e.verified)
          : fresh;
        e.status = { ...observed, stale: false, availability: deriveAvailability(observed.windows) };
        e.checkedAtMs = Date.parse(fresh.checkedAt);
        e.verified = true;
      } else {
        // Failed poll — keep last timestamped windows, no current claim.
        e.status = {
          ...e.status,
          availability: "unknown",
          error: fresh.error ?? e.status.error ?? "last poll failed",
        };
        e.verified = false;
      }
      e.attemptedAtMs = this.now();
      void this.persist();
      return this.cached(id);
    })().finally(() => {
      e.inFlight = undefined;
    });

    e.inFlight = run;
    return run;
  }

  private persist(): Promise<void> {
    if (!this.storage) return Promise.resolve();
    // Build straight from the cache — persisting must never cascade new polls.
    return this.storage.set(SNAPSHOT_KEY, this.snapshotFromCache()).then(
      () => undefined,
      () => undefined, // storage failures must not break reads
    );
  }

  /** Begin the background ~60s read-only poll loop (usage endpoints only — no inference probes). */
  async start(): Promise<void> {
    if (this.timer) return;
    await this.hydrate();
    void Promise.all(SOURCE_IDS.map((id) => this.poll(id, false))); // immediate first pass
    const t = setInterval(() => {
      void Promise.all(SOURCE_IDS.map((id) => this.poll(id, false)));
    }, this.ttlMs);
    t.unref?.(); // never hold the process open
    this.timer = t;
  }

  /** Stop the background loop. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
