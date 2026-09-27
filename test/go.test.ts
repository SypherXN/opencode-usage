import assert from "node:assert/strict";
import { test } from "node:test";

import { goProvider, parseGoUsage, isFreeGoModel } from "../src/providers/go.ts";
import type { SourceStatus } from "../src/types.ts";

const NOW = Date.parse("2026-09-26T12:00:00Z");

/** Build a mock fetch that returns a fixed JSON payload + status. */
function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

test("parseGoUsage: all three windows normalize percent and resetsAt", () => {
  const windows = parseGoUsage({
    usage: {
      rolling: { percent: 25, resetsAt: "2026-09-26T17:00:00Z" },
      weekly: { percent: 80, resetsAt: "2026-10-03T00:00:00Z" },
      monthly: { percent: 100, resetsAt: "2026-10-26T00:00:00Z" },
    },
  });
  assert.equal(windows.length, 3);
  assert.deepEqual(
    windows.map((w) => w.name).sort(),
    ["monthly", "rolling", "weekly"],
  );
  const rolling = windows.find((w) => w.name === "rolling")!;
  assert.equal(rolling.usedPercent, 25);
  assert.equal(rolling.state, "ok");
  assert.equal(rolling.resetsAt, "2026-09-26T17:00:00.000Z");
});

test("parseGoUsage: clamps out-of-range percent into [0,100]", () => {
  const windows = parseGoUsage({ usage: { rolling: { percent: 150, resetsAt: "2026-09-26T17:00:00Z" } } });
  assert.equal(windows[0].usedPercent, 100);
  const low = parseGoUsage({ usage: { rolling: { percent: -5, resetsAt: "2026-09-26T17:00:00Z" } } });
  assert.equal(low[0].usedPercent, 0);
});

test("parseGoUsage: invalid percent is dropped, never coerced to zero", () => {
  // Non-number percent must be excluded entirely (not turned into 0).
  assert.deepEqual(parseGoUsage({ usage: { rolling: { percent: "high", resetsAt: "2026-09-26T17:00:00Z" } } }), []);
  assert.deepEqual(parseGoUsage({ usage: { rolling: { percent: NaN, resetsAt: "2026-09-26T17:00:00Z" } } }), []);
  assert.deepEqual(parseGoUsage({ usage: { rolling: { resetsAt: "2026-09-26T17:00:00Z" } } }), []);
});

test("parseGoUsage: invalid resetsAt yields null but keeps the window", () => {
  const windows = parseGoUsage({ usage: { weekly: { percent: 40, resetsAt: "not-a-date" } } });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].resetsAt, null);
});

test("parseGoUsage: absent data / malformed payload => empty", () => {
  assert.deepEqual(parseGoUsage(null), []);
  assert.deepEqual(parseGoUsage(undefined as unknown), []);
  assert.deepEqual(parseGoUsage({}), []);
  assert.deepEqual(parseGoUsage({ usage: null }), []);
  assert.deepEqual(parseGoUsage({ usage: { rolling: null } }), []);
});

test("fetch: valid response => authenticated source with ok windows and derived availability", async () => {
  const provider = goProvider({ apiKey: "oc_sk_test", fetchImpl: mockFetch(200, {
    usage: {
      rolling: { percent: 25, resetsAt: "2026-09-26T17:00:00Z" },
      weekly: { percent: 10, resetsAt: "2026-10-03T00:00:00Z" },
      monthly: { percent: 50, resetsAt: "2026-10-26T00:00:00Z" },
    },
  }), now: () => NOW });
  const s = await provider.fetch();
  assert.equal(s.authenticated, true);
  assert.equal(s.stale, false);
  assert.equal(s.error, null);
  assert.equal(s.checkedAt, new Date(NOW).toISOString());
  assert.equal(s.availability, "available");
  assert.equal(s.windows.length, 3);
});

test("fetch: missing credential => unauthenticated unknown, no request made", async () => {
  let called = false;
  const provider = goProvider({ apiKey: null, fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch });
  const s = await provider.fetch();
  assert.equal(called, false);
  assert.equal(s.authenticated, false);
  assert.equal(s.availability, "unknown");
  assert.equal(s.error, "credential not found");
});

test("fetch: 401 => authentication failed, unknown (not limited)", async () => {
  const s = await goProvider({ apiKey: "bad", fetchImpl: mockFetch(401, {}) }).fetch();
  assert.equal(s.authenticated, true);
  assert.equal(s.availability, "unknown");
  assert.equal(s.error, "authentication failed");
});

test("fetch: 403 => authentication failed", async () => {
  const s = await goProvider({ apiKey: "bad", fetchImpl: mockFetch(403, {}) }).fetch();
  assert.equal(s.error, "authentication failed");
  assert.equal(s.availability, "unknown");
});

test("fetch: 429 => safe error, unknown (a generic 429 does not establish exhaustion)", async () => {
  const s = await goProvider({ apiKey: "k", fetchImpl: mockFetch(429, {}) }).fetch();
  assert.equal(s.availability, "unknown");
  assert.match(s.error ?? "", /HTTP 429/);
});

test("fetch: network failure => unknown, no throw", async () => {
  const throwing = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const s = await goProvider({ apiKey: "k", fetchImpl: throwing }).fetch();
  assert.equal(s.authenticated, true);
  assert.equal(s.availability, "unknown");
  assert.equal(s.error, "request failed or timed out");
});

test("fetch: malformed JSON => unknown, no throw", async () => {
  const badJson = (async () => new Response("not json", { status: 200 })) as typeof fetch;
  const s = await goProvider({ apiKey: "k", fetchImpl: badJson }).fetch();
  assert.equal(s.error, "malformed JSON response");
  assert.equal(s.availability, "unknown");
});

test("fetch: empty/unparseable usage => unknown, no throw", async () => {
  const s = await goProvider({ apiKey: "k", fetchImpl: mockFetch(200, { usage: {} }) }).fetch();
  assert.equal(s.error, "usage data could not be parsed");
  assert.equal(s.availability, "unknown");
});

test("fetch: fully-consumed window carries through faithfully", async () => {
  const provider = goProvider({ apiKey: "k", fetchImpl: mockFetch(200, {
    usage: { rolling: { percent: 100, resetsAt: "2026-09-26T17:00:00Z" } },
  }), now: () => NOW });
  const s = await provider.fetch();
  assert.equal(s.windows[0].usedPercent, 100);
  assert.equal(s.windows[0].state, "rate-limited");
  assert.equal(s.availability, "limited");
  assert.equal(s.authenticated, true);
});

test("fetch: a nearly-full window (99.9%) stays ok (no exhaustion claim)", async () => {
  const s = await goProvider({ apiKey: "k", fetchImpl: mockFetch(200, {
    usage: { rolling: { percent: 99.9, resetsAt: "2026-09-26T17:00:00Z" } },
  }), now: () => NOW }).fetch();
  assert.equal(s.windows[0].usedPercent, 99.9);
  assert.equal(s.windows[0].state, "ok");
  assert.equal(s.availability, "available");
});

test("free-model detection: known free id exempt, paid id not", () => {
  const free = new Set(["space-bunny-free", "longcat-2.5-preview-free"]);
  assert.equal(isFreeGoModel("space-bunny-free", free), true);
  assert.equal(isFreeGoModel("grok-4.7", free), false);
});

test("serialized SourceStatus carries no credential material", async () => {
  const s: SourceStatus = await goProvider({ apiKey: "oc_sk_secret_value", fetchImpl: mockFetch(200, {
    usage: { rolling: { percent: 1, resetsAt: "2026-09-26T17:00:00Z" } },
  }), now: () => NOW }).fetch();
  const json = JSON.stringify(s);
  for (const forbidden of ["oc_sk_secret_value", "bearer", "authorization"]) {
    assert.ok(!json.toLowerCase().includes(forbidden), `status must not contain "${forbidden}"`);
  }
});
