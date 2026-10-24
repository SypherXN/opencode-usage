// Status engine tests (task #7).
//
// Everything is fake: scripted providers, fake clock, in-memory storage.
// No live HTTP, no quota-consuming calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SNAPSHOT_KEY, StatusEngine } from "../src/status.ts";
import type { SourceId } from "../src/status.ts";
import { deriveAvailability, deriveNextAvailableAt, STALE_AFTER_MS, STALE_RETRY_MS, unknownSource } from "../src/types.ts";
import type { QuotaSource, SourceStatus, StorageLike, StatusSnapshot, UsageWindow, WindowState } from "../src/types.ts";

const T0 = 1_758_900_000_000; // fixed instant
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MIN = 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();

function fakeClock(start: number = T0): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; }, set: (ms) => { now = ms; } };
}

interface WinSpec {
  name: string;
  percent: number;
  state?: WindowState;
  resetsAt?: string | null;
}

/** Build a successful SourceStatus from window specs. */
function okSource(id: SourceId, wins: WinSpec[], atMs: number): SourceStatus {
  const windows: UsageWindow[] = wins.map((w) => ({
    name: w.name,
    usedPercent: w.percent,
    state: w.state ?? (w.percent >= 100 ? "rate-limited" : "ok"),
    resetsAt: w.resetsAt ?? null,
  }));
  return {
    authenticated: true,
    checkedAt: iso(atMs),
    stale: false,
    error: null,
    windows,
    availability: deriveAvailability(windows),
  };
}

/** Three healthy Go windows (rolling 5h, weekly, monthly) at a given instant. */
const GO_OK = (atMs: number): SourceStatus =>
  okSource(
    "go",
    [
      { name: "rolling", percent: 40, resetsAt: iso(atMs + 5 * HOUR) },
      { name: "weekly", percent: 10, resetsAt: iso(atMs + 6 * DAY) },
      { name: "monthly", percent: 5, resetsAt: iso(atMs + 30 * DAY) },
    ],
    atMs,
  );

/** Go with a capped rolling window; resetsAt may be null (missing timestamp). */
const GO_CAPPED_ROLLING = (atMs: number, resetsAt: string | null): SourceStatus =>
  okSource(
    "go",
    [
      { name: "rolling", percent: 100, state: "rate-limited", resetsAt },
      { name: "weekly", percent: 10, resetsAt: iso(atMs + 6 * DAY) },
      { name: "monthly", percent: 5, resetsAt: iso(atMs + 30 * DAY) },
    ],
    atMs,
  );

/** Scripted QuotaSource: one canned result per fetch(), counts every call. */
function scriptedProvider(id: SourceId, script: Array<SourceStatus | "fail">): { provider: QuotaSource; calls: { current: number } } {
  const calls = { current: 0 };
  const provider: QuotaSource = {
    id,
    async fetch() {
      calls.current += 1;
      const next = script[calls.current - 1] ?? "fail";
      return next === "fail"
        ? unknownSource(id, { authenticated: true, error: "request failed or timed out" })
        : next;
    },
  };
  return { provider, calls };
}

/** In-memory StorageLike with a shared observable data map. */
function memStorage(initial: Record<string, unknown> = {}): { storage: StorageLike; data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  const storage: StorageLike = {
    async get(key) { return data[key]; },
    async set(key, value) { data[key] = value; },
    async remove(key) { delete data[key]; },
  };
  return { storage, data };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("StatusEngine.read", () => {
  it("coalesces concurrent cold reads into a single upstream fetch", async () => {
    const clock = fakeClock();
    const { provider, calls } = scriptedProvider("go", [GO_OK(T0)]);
    const { storage } = memStorage();
    const engine = new StatusEngine({ providers: { go: provider }, storage, now: clock.now });
    const [a, b, c] = await Promise.all([engine.read("go"), engine.read("go"), engine.read("go")]);
    assert.equal(calls.current, 1);
    assert.equal(a.availability, "available");
    assert.equal(b.availability, "available");
    assert.equal(c.availability, "available");
    assert.equal(a.stale, false);
  });

  it("serves readers within the TTL from cache with no extra upstream calls", async () => {
    const clock = fakeClock();
    const { provider, calls } = scriptedProvider("go", [GO_OK(T0)]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now });
    await engine.read("go");
    clock.advance(30_000);
    const second = await engine.read("go");
    assert.equal(calls.current, 1, "cache served — no second upstream call");
    assert.equal(second.checkedAt, iso(T0));
  });

  it("re-polls once the TTL expires", async () => {
    const clock = fakeClock();
    const { provider, calls } = scriptedProvider("go", [GO_OK(T0), GO_OK(T0 + 61_000)]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now });
    await engine.read("go");
    clock.advance(61_000);
    const second = await engine.read("go");
    assert.equal(calls.current, 2);
    assert.equal(second.checkedAt, iso(T0 + 61_000));
  });

  it("reports unconfigured sources as unknown without polling", async () => {
    const engine = new StatusEngine({ storage: memStorage().storage, now: fakeClock().now });
    const r = await engine.read("cursor");
    assert.equal(r.authenticated, false);
    assert.equal(r.availability, "unknown");
    assert.equal(r.stale, true);
    assert.match(r.error ?? "", /not configured/);
  });
});

describe("StatusEngine reset rechecks", () => {
  it("rechecks a capped window after the TTL, before the reported reset", async () => {
    const clock = fakeClock();
    const { provider, calls } = scriptedProvider("go", [
      GO_CAPPED_ROLLING(T0, iso(T0 + 2 * HOUR)),
      GO_CAPPED_ROLLING(T0 + 61_000, iso(T0 + 2 * HOUR)),
      GO_OK(T0 + 2 * HOUR),
    ]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now });
    const first = await engine.read("go");
    assert.equal(first.availability, "limited");
    assert.equal(calls.current, 1);

    clock.set(T0 + 61_000); // TTL expired, reported reset still in the future
    const early = await engine.read("go");
    assert.equal(calls.current, 2, "rechecks before the reported reset");
    assert.equal(early.availability, "limited");

    clock.set(T0 + 2 * HOUR + 1_000); // just past the reset
    const after = await engine.read("go");
    assert.equal(calls.current, 3, "re-fetches when the cap lifts");
    assert.equal(after.availability, "available");
  });

  it("expires windows independently — a monthly cap still blocks after a 5h reset", async () => {
    const clock = fakeClock();
    const cappedBoth = okSource("go", [
      { name: "rolling", percent: 100, state: "rate-limited", resetsAt: iso(T0 + 5 * HOUR) },
      { name: "weekly", percent: 10, resetsAt: iso(T0 + 6 * DAY) },
      { name: "monthly", percent: 100, state: "rate-limited", resetsAt: iso(T0 + 30 * DAY) },
    ], T0);
    const rollingOkMonthlyCapped = okSource("go", [
      { name: "rolling", percent: 0, resetsAt: iso(T0 + 10 * HOUR) },
      { name: "weekly", percent: 10, resetsAt: iso(T0 + 6 * DAY) },
      { name: "monthly", percent: 100, state: "rate-limited", resetsAt: iso(T0 + 29 * DAY) },
    ], T0 + 5 * HOUR);
    const allOk = GO_OK(T0 + 30 * DAY);

    const { provider, calls } = scriptedProvider("go", [cappedBoth, rollingOkMonthlyCapped, allOk]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now });

    await engine.read("go");
    assert.equal(calls.current, 1);

    clock.set(T0 + 5 * HOUR + 1_000); // past the 5h reset
    const mid = await engine.read("go");
    assert.equal(calls.current, 2, "5h window expired — poll again");
    assert.equal(mid.availability, "limited", "monthly cap still blocks after the 5h reset");

    clock.set(T0 + 29 * DAY + 1_000); // past the monthly reset
    const end = await engine.read("go");
    assert.equal(calls.current, 3);
    assert.equal(end.availability, "available");
  });

  it("a paid pool never reads available while any shared cap window is active", async () => {
    const clock = fakeClock();
    const { provider } = scriptedProvider("go", [
      GO_CAPPED_ROLLING(T0, iso(T0 + 2 * HOUR)),
      GO_CAPPED_ROLLING(T0 + 60_000, iso(T0 + 2 * HOUR)),
    ]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now });
    await engine.read("go");
    clock.set(T0 + 60_000); // TTL expired; the recheck is still capped
    const served = await engine.read("go");
    assert.notEqual(served.availability, "available");
  });

  it("rechecks a capped window that has no reset timestamp after the TTL", async () => {
    const clock = fakeClock();
    const { provider, calls } = scriptedProvider("go", [
      GO_CAPPED_ROLLING(T0, null),
      GO_OK(T0 + 61_000),
    ]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now });
    await engine.read("go");
    assert.equal(calls.current, 1);

    clock.set(T0 + 61_000);
    const after = await engine.read("go");
    assert.equal(calls.current, 2, "a missing reset does not freeze the source");
    assert.equal(after.availability, "available");
  });

  it("keeps polling estimated Cursor resets after the cache TTL", async () => {
    const clock = fakeClock();
    const estimated = (atMs: number) => ({
      ...okSource("cursor", [{ name: "auto", percent: 100, resetsAt: iso(T0 + 2 * HOUR) }], atMs),
      windows: [{
        name: "auto",
        usedPercent: 100,
        state: "rate-limited" as const,
        resetsAt: iso(T0 + 2 * HOUR),
        resetEstimated: true as const,
      }],
    });
    const { provider, calls } = scriptedProvider("cursor", [estimated(T0), estimated(T0 + 61_000)]);
    const engine = new StatusEngine({ providers: { cursor: provider }, storage: memStorage().storage, now: clock.now });

    await engine.read("cursor");
    clock.set(T0 + 61_000);
    const refreshed = await engine.read("cursor");

    assert.equal(calls.current, 2, "estimated reset dates do not suppress usage polling");
    assert.equal(refreshed.stale, false);
    assert.equal(refreshed.nextAvailableAt, iso(T0 + 2 * HOUR));
  });
});

describe("StatusEngine unhealthy retry cadence", () => {
  it("retries an unhealthy source after staleRetryMs, inside the cache TTL", async () => {
    const clock = fakeClock();
    const { provider, calls } = scriptedProvider("go", [GO_OK(T0), "fail", GO_OK(T0 + 2 * STALE_RETRY_MS)]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now, ttlMs: MIN });

    await engine.read("go");
    assert.equal(calls.current, 1);

    clock.set(T0 + MIN); // the cache TTL elapsed
    await engine.read("go"); // this attempt fails
    assert.equal(calls.current, 2);

    clock.set(T0 + MIN + STALE_RETRY_MS - 1);
    await engine.read("go");
    assert.equal(calls.current, 2, "no retry inside staleRetryMs");

    clock.set(T0 + MIN + STALE_RETRY_MS);
    await engine.read("go");
    assert.equal(calls.current, 3, "retries staleRetryMs after the failed attempt, not a full TTL later");
  });

  it("keeps the cache TTL when the unhealthy source is capped until a known reset", async () => {
    const clock = fakeClock();
    const capped = GO_CAPPED_ROLLING(T0, iso(T0 + 30 * DAY));
    const { provider, calls } = scriptedProvider("go", [capped, "fail", capped]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now, ttlMs: MIN });

    await engine.read("go");
    clock.set(T0 + MIN);
    await engine.read("go"); // this attempt fails; the kept windows are still capped
    assert.equal(calls.current, 2);

    clock.set(T0 + MIN + STALE_RETRY_MS);
    await engine.read("go");
    assert.equal(calls.current, 2, "a known cap keeps the full cache TTL");

    clock.set(T0 + 2 * MIN);
    await engine.read("go");
    assert.equal(calls.current, 3);
  });
});

describe("StatusEngine failures and stale data", () => {
  it("keeps last-known windows on a failed poll, claims no availability, and ages into stale", async () => {
    const clock = fakeClock();
    const { provider, calls } = scriptedProvider("go", [GO_OK(T0), "fail"]);
    const { storage, data } = memStorage();
    const engine = new StatusEngine({ providers: { go: provider }, storage, now: clock.now });
    const first = await engine.read("go");
    assert.equal(first.availability, "available");

    clock.advance(61_000); // TTL expired
    const failed = await engine.read("go"); // upstream fails this time
    assert.equal(calls.current, 2);
    assert.equal(failed.availability, "unknown", "a failed poll never reports available");
    assert.equal(failed.stale, false, "one failed poll does not age the data");
    assert.equal(failed.error, "request failed or timed out");
    assert.equal(failed.windows.length, 3, "last known windows retained");
    assert.equal(failed.checkedAt, iso(T0), "original timestamp kept");

    clock.set(T0 + STALE_AFTER_MS + 1); // still no successful poll since T0
    const aged = await engine.read("go");
    assert.equal(aged.stale, true, "ages into stale once the data is too old");

    const snap = data[SNAPSHOT_KEY] as StatusSnapshot;
    assert.equal(snap.sources.go.availability, "unknown");
    assert.equal(snap.sources.go.stale, true);
  });

  it("refresh() forces an immediate read-only poll inside the TTL (denial trigger)", async () => {
    const clock = fakeClock();
    const { provider, calls } = scriptedProvider("go", [
      GO_CAPPED_ROLLING(T0, iso(T0 + 2 * HOUR)),
      GO_OK(T0 + 1_000),
    ]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now });
    await engine.read("go");
    assert.equal(calls.current, 1);

    clock.set(T0 + 1_000); // still inside the TTL
    const viaRead = await engine.read("go");
    assert.equal(calls.current, 1, "read() serves the fresh cache");
    assert.equal(viaRead.availability, "limited");

    const forced = await engine.refresh("go");
    assert.equal(calls.current, 2, "denial trigger bypasses the TTL");
    assert.equal(forced.availability, "available");
  });
});

describe("StatusEngine persistence and restart", () => {
  it("tracks a Cursor drop to zero as a monthly reset day across restart", async () => {
    const jan10 = Date.UTC(2026, 0, 10, 12);
    const feb10 = Date.UTC(2026, 1, 10, 12);
    const mar1 = Date.UTC(2026, 2, 1, 12);
    const clock = fakeClock(jan10);
    const { storage, data } = memStorage();
    const firstProvider = scriptedProvider("cursor", [
      okSource("cursor", [{ name: "billing_cycle", percent: 65 }], jan10),
      okSource("cursor", [{ name: "billing_cycle", percent: 0 }], feb10),
    ]);
    const firstEngine = new StatusEngine({ providers: { cursor: firstProvider.provider }, storage, now: clock.now });

    await firstEngine.read("cursor");
    clock.set(feb10);
    const reset = await firstEngine.read("cursor");
    const resetWindow = reset.windows[0];
    assert.ok("resetDay" in resetWindow);
    assert.equal(resetWindow.resetDay, 10);
    assert.equal(resetWindow.resetsAt, "2026-03-10T00:00:00.000Z");
    assert.ok("resetEstimated" in resetWindow && resetWindow.resetEstimated);

    clock.set(mar1);
    const nextProvider = scriptedProvider("cursor", [
      okSource("cursor", [{ name: "billing_cycle", percent: 5 }], mar1),
    ]);
    const restarted = new StatusEngine({ providers: { cursor: nextProvider.provider }, storage, now: clock.now });
    await restarted.hydrate();
    const afterRestart = await restarted.read("cursor");
    const restoredWindow = afterRestart.windows[0];
    assert.ok("resetDay" in restoredWindow);
    assert.equal(restoredWindow.resetDay, 10);
    assert.equal(restoredWindow.resetsAt, "2026-03-10T00:00:00.000Z");
    assert.ok("resetEstimated" in restoredWindow && restoredWindow.resetEstimated);
    const persistedWindow = (data[SNAPSHOT_KEY] as StatusSnapshot).sources.cursor.windows[0];
    assert.ok("resetDay" in persistedWindow);
    assert.equal(persistedWindow.resetDay, 10);
  });

  it("uses a one-time Cursor reset seed until a drop to zero learns the day", async () => {
    const sep27 = Date.UTC(2026, 8, 27, 12);
    const sep30 = Date.UTC(2026, 8, 30, 12);
    const clock = fakeClock(sep27);
    const { provider } = scriptedProvider("cursor", [
      okSource("cursor", [{ name: "billing_cycle", percent: 100 }], sep27),
      okSource("cursor", [{ name: "billing_cycle", percent: 0 }], sep30),
    ]);
    const engine = new StatusEngine({
      providers: { cursor: provider },
      storage: memStorage().storage,
      now: clock.now,
      cursorResetAt: "2026-09-30T00:00:00.000Z",
    });

    const seeded = await engine.read("cursor");
    assert.equal(seeded.windows[0].resetsAt, "2026-09-30T00:00:00.000Z");
    assert.ok("resetEstimated" in seeded.windows[0] && seeded.windows[0].resetEstimated);

    clock.set(sep30);
    const observed = await engine.read("cursor");
    const window = observed.windows[0];
    assert.ok("resetDay" in window);
    assert.equal(window.resetDay, 30);
    assert.equal(window.resetsAt, "2026-10-30T00:00:00.000Z");
    assert.ok("resetEstimated" in window && window.resetEstimated);
  });

  it("persists the snapshot after a successful poll and serves it after restart", async () => {
    const clock = fakeClock();
    const a = scriptedProvider("go", [GO_OK(T0)]);
    const { storage, data } = memStorage();
    const engineA = new StatusEngine({ providers: { go: a.provider }, storage, now: clock.now });
    await engineA.read("go");

    const persisted = data[SNAPSHOT_KEY] as StatusSnapshot;
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.sources.go.checkedAt, iso(T0));
    assert.equal(persisted.sources.go.availability, "available");

    // "Restart": a fresh engine hydrates from the same storage.
    const b = scriptedProvider("go", []); // any upstream call would break the script
    const engineB = new StatusEngine({ providers: { go: b.provider }, storage, now: clock.now });
    await engineB.hydrate();
    clock.advance(30_000); // still within the TTL of the persisted data
    const restored = await engineB.read("go");
    assert.equal(b.calls.current, 0, "persisted snapshot served — no upstream poll");
    assert.equal(restored.availability, "available");
    assert.equal(restored.checkedAt, iso(T0));
  });
});

describe("StatusEngine snapshot", () => {
  it("produces a versioned document with all sources and empty model estimates", async () => {
    const clock = fakeClock();
    const { provider } = scriptedProvider("go", [GO_OK(T0)]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now });
    const snap = await engine.snapshot();
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.updatedAt, iso(T0));
    assert.ok(snap.sources.go && snap.sources.codex && snap.sources.cursor);
    assert.equal(snap.sources.go.availability, "available");
    assert.equal(snap.sources.go.nextAvailableAt, null);
    assert.equal(snap.sources.codex.availability, "unknown");
    assert.equal(snap.sources.codex.nextAvailableAt, null);
    assert.deepEqual(snap.models.go, {});
  });

  it("reports when every rate-limited window should reset", async () => {
    const clock = fakeClock(T0);
    const fiveHourReset = iso(T0 + 5 * HOUR);
    const weeklyReset = iso(T0 + 7 * DAY);
    const windows: UsageWindow[] = [
      { name: "primary_5h", usedPercent: 100, state: "rate-limited", resetsAt: fiveHourReset },
      { name: "secondary_7d", usedPercent: 100, state: "rate-limited", resetsAt: weeklyReset },
    ];
    const { provider } = scriptedProvider("codex", [okSource("codex", windows.map((w) => ({
      name: w.name,
      percent: w.usedPercent ?? 0,
      state: w.state,
      resetsAt: w.resetsAt,
    })), T0)]);
    const engine = new StatusEngine({ providers: { codex: provider }, storage: memStorage().storage, now: clock.now });
    const snap = await engine.snapshot();
    assert.equal(snap.sources.codex.nextAvailableAt, weeklyReset);
    assert.equal(snap.sources.go.nextAvailableAt, null);

    clock.advance(STALE_AFTER_MS + 1);
    const stale = await engine.snapshot();
    assert.equal(stale.sources.codex.stale, true);
    assert.equal(stale.sources.codex.nextAvailableAt, weeklyReset);
  });

  it("returns the sole limiting reset and withholds unknown or expired reset times", () => {
    const now = T0;
    const fiveHourReset = iso(now + 5 * HOUR);
    const weeklyReset = iso(now + 7 * DAY);
    const window = (name: string, resetsAt: string | null, state: "ok" | "rate-limited" = "rate-limited"): UsageWindow => ({
      name,
      usedPercent: state === "ok" ? 20 : 100,
      state,
      resetsAt,
    });

    assert.equal(deriveNextAvailableAt([window("primary_5h", fiveHourReset)], now), fiveHourReset);
    assert.equal(deriveNextAvailableAt([window("secondary_7d", weeklyReset)], now), weeklyReset);
    assert.equal(deriveNextAvailableAt([window("primary_5h", fiveHourReset), window("secondary_7d", weeklyReset)], now), weeklyReset);
    assert.equal(deriveNextAvailableAt([window("primary_5h", null)], now), null);
    assert.equal(deriveNextAvailableAt([window("primary_5h", iso(now - 1))], now), null);
    assert.equal(deriveNextAvailableAt([window("primary_5h", fiveHourReset, "ok")], now), null);
  });

  it("includes registered per-model estimates (estimates, not quotas)", async () => {
    const clock = fakeClock();
    const { provider } = scriptedProvider("go", [GO_OK(T0)]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, now: clock.now });
    engine.setModelEstimator((go) => ({
      "go-model-x": {
        observedTokens: 1000,
        estimatedCostUSD: 0.01,
        priceProvenance: "published 2026-09 docs",
        free: false,
        effectiveAvailability: go.availability,
      },
    }));
    const snap = await engine.snapshot();
    const est = snap.models.go["go-model-x"];
    assert.equal(est.observedTokens, 1000);
    assert.equal(est.estimatedCostUSD, 0.01);
    assert.equal(est.effectiveAvailability, "available");
  });
});

describe("StatusEngine background loop", () => {
  it("start() polls immediately and on the interval; stop() halts the loop", async () => {
    // Real timers here (short interval); the fake clock would freeze the loop.
    const { provider, calls } = scriptedProvider("go", [
      GO_OK(T0), GO_OK(T0 + 25), GO_OK(T0 + 50), GO_OK(T0 + 75), GO_OK(T0 + 100),
    ]);
    const engine = new StatusEngine({ providers: { go: provider }, storage: memStorage().storage, ttlMs: 25 });
    await engine.start();
    assert.equal(calls.current, 1, "immediate first poll on start");

    await sleep(90); // ~3 intervals elapse
    assert.ok(calls.current >= 2, "the background loop keeps polling read-only usage");

    engine.stop();
    const atStop = calls.current;
    await sleep(80);
    assert.equal(calls.current, atStop, "no further polls after stop");
  });
});
