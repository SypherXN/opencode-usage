import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeAgentObserver, parseClaudeRateLimit } from "../src/providers/claude-agent.ts";
import { SNAPSHOT_KEY, StatusEngine } from "../src/status.ts";
import { STALE_AFTER_MS, type StorageLike } from "../src/types.ts";

const T0 = Date.parse("2026-11-03T12:00:00Z");
const info = { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.75, resetsAt: (T0 + 3600000) / 1000 };
const start = (providerID = "claude-agent") => ({
  type: "session.step.started", created: T0,
  data: { sessionID: "s1", assistantMessageID: "m1", model: { providerID } },
});
const end = (metadata: object, extra: object = {}) => ({
  type: "session.step.ended", created: T0,
  data: { sessionID: "s1", assistantMessageID: "m1", ...metadata }, ...extra,
});

test("Claude quota parses fractions, SDK status and Unix seconds without inventing missing values", () => {
  const status = parseClaudeRateLimit(info, T0)!;
  assert.equal(status.windows[0].usedPercent, 75);
  assert.equal(status.windows[0].resetsAt, new Date(T0 + 3600000).toISOString());
  assert.equal(status.availability, "available");
  assert.equal(status.checkedAt, new Date(T0).toISOString());
  assert.equal(parseClaudeRateLimit({ status: "allowed" }, T0)!.windows[0].usedPercent, null);
  assert.equal(parseClaudeRateLimit({ status: "allowed" }, T0)!.windows[0].name, "reported");
  for (const utilization of [-1, 2, NaN, Infinity, "0.4", null]) {
    const parsed = parseClaudeRateLimit({ ...info, utilization, resetsAt: Infinity }, T0)!;
    assert.equal(parsed.windows[0].usedPercent, null);
    assert.equal(parsed.windows[0].resetsAt, null);
  }
  assert.equal(parseClaudeRateLimit({ status: "nonsense" }, T0), null);
  assert.equal(parseClaudeRateLimit(null, T0), null);
  assert.equal(parseClaudeRateLimit(info, NaN), null);
});

test("rejected quota is limited, but overage availability prevents a false block", () => {
  assert.equal(parseClaudeRateLimit({ ...info, status: "rejected" }, T0)!.availability, "limited");
  for (const extra of [{ isUsingOverage: true }, { overageInUse: true }, { overageStatus: "allowed" }]) {
    assert.equal(parseClaudeRateLimit({ ...info, status: "rejected", ...extra }, T0)!.availability, "unknown");
  }
});

test("only correlated Claude steps expose quota; old and new metadata fields work", () => {
  const observer = new ClaudeAgentObserver();
  const finish = end({ native: { rateLimit: info, privateText: "not retained" } });
  assert.equal(observer.observe(finish), null);
  observer.observe(start("anthropic"));
  assert.equal(observer.observe(finish), null);
  for (const field of ["native", "providerState"]) {
    observer.observe(start());
    assert.equal(observer.observe(end({ [field]: { rateLimit: info } }))!.windows[0].usedPercent, 75);
    assert.equal(observer.observe(finish), null); // terminal event consumes identity
  }
  observer.observe(start());
  assert.equal(observer.observe(end({ native: { rateLimit: info } }, { type: "session.step.failed" }))!.availability, "available");
  observer.observe(start());
  assert.equal(observer.observe(end({ native: {} })), null);
  assert.equal(observer.observe(null), null);
});

test("passive Claude data persists and ages without polling or assuming a reset recovered", async () => {
  let now = T0;
  const values = new Map<string, unknown>();
  const storage: StorageLike = {
    async get(key) { return values.get(key); },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
  const engine = new StatusEngine({ storage, now: () => now });
  assert.equal((await engine.read("claude-agent")).availability, "unknown");
  const observed = parseClaudeRateLimit(info, T0)!;
  await engine.observe("claude-agent", observed);
  assert.ok(values.has(SNAPSHOT_KEY));
  now += 60000;
  assert.equal((await engine.refresh("claude-agent")).checkedAt, observed.checkedAt);
  const restored = new StatusEngine({ storage, now: () => now });
  await restored.hydrate();
  assert.equal((await restored.snapshot()).sources["claude-agent"].windows[0].usedPercent, 75);
  now = T0 + STALE_AFTER_MS + 1;
  assert.equal((await restored.read("claude-agent")).availability, "unknown");
  assert.equal((await restored.read("claude-agent")).stale, true);
  const recent = parseClaudeRateLimit({ ...info, status: "rejected", resetsAt: (now + 1000) / 1000 }, now)!;
  await restored.observe("claude-agent", recent);
  await restored.observe("claude-agent", observed); // replay must not replace a newer observation
  assert.equal((await restored.read("claude-agent")).availability, "limited");
  now += 1001;
  const expired = await restored.read("claude-agent");
  assert.equal(expired.availability, "unknown");
  assert.equal(expired.stale, true);
  assert.equal(expired.nextAvailableAt, null);
});
