// Task #9 (status-rpc) tests: the read-only `opencode-usage.status` RPC.
//
// The host simulation below mirrors what the V2 host does: validate the input
// through the schema's standard-schema `validate`, invoke the handler, then
// validate the output the same way. No credentials are ever part of the
// document, and no provider failure breaks the query.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createStatusHandler,
  STATUS_INPUT,
  STATUS_OUTPUT,
  USAGE_RPC,
  type StatusProvider,
} from "../src/rpc.ts";
import type { SourceId } from "../src/status.ts";
import { SCHEMA_VERSION, type GoModelEstimate, type SourceStatus, type StatusSnapshotSource } from "../src/types.ts";

const T0 = 1_760_000_000_000;

function source(overrides: Partial<SourceStatus> = {}): StatusSnapshotSource {
  return {
    authenticated: true,
    checkedAt: new Date(T0).toISOString(),
    stale: false,
    error: null,
    windows: [{ name: "rolling", usedPercent: 20, state: "ok", resetsAt: null }],
    availability: "available",
    nextAvailableAt: null,
    ...overrides,
  };
}

const ESTIMATE: GoModelEstimate = {
  observedTokens: 1200,
  estimatedCostUSD: 0.02,
  priceProvenance: "estimate only (NOT an official quota percentage): published docs",
  free: false,
  effectiveAvailability: "available",
  // additive field from #8 — must survive output validation (passthrough)
  byWindow: { rolling: { observedTokens: 1200, estimatedCostUSD: 0.02 } },
};

function engineFake(overrides: Partial<Record<SourceId, Partial<SourceStatus>>> = {}) {
  const refreshed: SourceId[] = [];
  const provider: StatusProvider = {
    snapshot: async () => ({
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date(T0).toISOString(),
      sources: {
        go: source(overrides.go),
        codex: source(overrides.codex),
        cursor: source(overrides.cursor),
      },
      models: { go: { "kimi-k3": { ...ESTIMATE } } },
    }),
    refresh: async (id) => {
      refreshed.push(id);
      return source(overrides[id]);
    },
  };
  return { provider, refreshed };
}

/** Simulates the V2 host: validate input, run the handler, validate output. */
async function hostConsume<T>(handler: (input: { refresh?: boolean }) => Promise<T>, input: unknown) {
  const inRes = await STATUS_INPUT["~standard"].validate(input);
  if (inRes.issues) throw new Error(`input rejected by host validation: ${JSON.stringify(inRes.issues)}`);
  const out = await handler(inRes.value);
  const outRes = await STATUS_OUTPUT["~standard"].validate(out);
  if (outRes.issues) throw new Error(`output rejected by host validation: ${JSON.stringify(outRes.issues)}`);
  return out;
}

describe("rpc definition", () => {
  it("exposes one read-only status method on opencode-usage", () => {
  assert.equal(USAGE_RPC.id, "opencode-usage");
    assert.ok(USAGE_RPC.methods.status.input);
    assert.ok(USAGE_RPC.methods.status.output);
  });
});

describe("input validation (host-faithful)", () => {
  const cases: Array<[input: unknown, accepted: boolean]> = [
    [{}, true],
    [{ refresh: true }, true],
    [{ refresh: false }, true],
    [{ refresh: "yes" }, false],
    [{ refresh: 1 }, false],
    [{ token: "sk-secret" }, false],
    [{ refresh: true, extra: 1 }, false],
  ];

  it("accepts only the documented refresh flag — nothing else (secrets rejected)", async () => {
    for (const [input, accepted] of cases) {
      const res = await STATUS_INPUT["~standard"].validate(input);
      if (accepted) assert.equal(res.issues, undefined, `expected accepted: ${JSON.stringify(input)}`);
      else assert.ok(res.issues, `expected rejected: ${JSON.stringify(input)}`);
    }
  });
});

describe("status handler", () => {
  it("a mock consumer queries the full status document", async () => {
    const { provider } = engineFake();
    const handler = createStatusHandler({ provider });
    const out = await hostConsume(handler, {});
    assert.equal(out.schemaVersion, 1);
    assert.equal(out.sources.go.availability, "available");
    assert.equal(out.sources.codex.availability, "available");
    assert.equal(out.sources.cursor.availability, "available");
    assert.equal(out.models.go["kimi-k3"].estimatedCostUSD, 0.02);
    assert.equal((out.models.go["kimi-k3"] as Record<string, unknown>)["byWindow"] !== undefined, true, "additive byWindow survives");
  });

  it("one failed source does not break the query", async () => {
    const { provider } = engineFake({
      go: { authenticated: false, checkedAt: null, stale: true, error: "authentication failed", windows: [], availability: "unknown" },
    });
    const handler = createStatusHandler({ provider });
    const out = await hostConsume(handler, {});
    assert.equal(out.sources.go.availability, "unknown");
    assert.equal(out.sources.go.error, "authentication failed");
    assert.equal(out.sources.codex.availability, "available");
    assert.equal(out.sources.cursor.availability, "available");
  });

  it("carries no credential material at the RPC boundary", async () => {
    const secret = "sk-fixture-token-abc123";
    const { provider } = engineFake();
    // A real engine holds resolved credentials internally; none of that
    // material may reach the response.
    const providerWithCreds = Object.assign({}, provider, { credentials: { go: secret } });
    const handler = createStatusHandler({ provider: providerWithCreds });
    const raw = await handler({});
    assert.ok(!JSON.stringify(raw).includes(secret), "credential value must not appear in the RPC response");
    assert.equal(raw.sources.go.error, null);
  });

  it("manual refresh is rate-limited to one per window and cached reads never refresh", async () => {
    const { provider, refreshed } = engineFake();
    let nowMs = T0;
    const handler = createStatusHandler({ provider, now: () => nowMs });

    await handler({ refresh: true });
    assert.deepEqual(refreshed, ["go", "codex", "cursor"]);

    nowMs += 10_000;
    await handler({ refresh: true });
    assert.equal(refreshed.length, 3, "within the 60s window no further refresh");

    await handler({});
    assert.equal(refreshed.length, 3, "cached reads never refresh");

    nowMs += 61_000;
    await handler({ refresh: true });
    assert.equal(refreshed.length, 6, "after the window a refresh is allowed again");
  });
});
