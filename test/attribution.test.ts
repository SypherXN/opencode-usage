import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GoAttribution,
  estimateObservationCost,
  extractUsage,
  isGoUsageDenial,
  normalizeModelId,
  parsePriceTable,
} from "../src/attribution.ts";
import type { SourceStatus, StorageLike } from "../src/types.ts";

const MARKDOWN = `# Go
Usage limits are defined as monthly dollar amounts.
| Model | Input | Output | Cached Read | Cached Write | Monthly limit |
| --------------------------------------- | ------ | ------ | ----------- | ------------ | ------ |
| Kimi K3 | $3.00 | $15.00 | $0.30 | - | **$15** |
| GLM-5.3-Flash | $0.15 | $0.50 | $0.03 | - | **$60** |
| Space Bunny Free | - | - | - | - | - |
`;

const MODELS_BODY = JSON.stringify({
  object: "list",
  data: [
    { id: "kimi-k3", object: "model" },
    { id: "glm-5.3-flash", object: "model" },
    { id: "space-bunny-free", object: "model" },
  ],
});

/** In-memory StorageLike. */
class MemStorage implements StorageLike {
  map = new Map<string, unknown>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: unknown) {
    this.map.set(key, value);
  }
  async remove(key: string) {
    this.map.delete(key);
  }
}

/** Scripted fetch: /models gets the model list, everything else gets MARKDOWN. */
function catalogFetch(calls: string[]): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/models")) {
      return new Response(MODELS_BODY, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(MARKDOWN, { status: 200, headers: { "Content-Type": "text/markdown" } });
  }) as unknown as typeof fetch;
}

/** Build a completion response body. */
function completionBody(id: string | null, prompt: number, completion: number, extra: Record<string, unknown> = {}) {
  const u: Record<string, unknown> = { prompt_tokens: prompt, completion_tokens: completion };
  Object.assign(u, extra);
  const root: Record<string, unknown> = { object: "chat.completion", model: "kimi-k3", choices: [] };
  if (id !== null) root.id = id;
  root.usage = u;
  return JSON.stringify(root);
}

describe("normalizeModelId", () => {
  it("normalizes display names and passes IDs through", () => {
    assert.equal(normalizeModelId("GPT 6 Luna"), "gpt-6-luna");
    assert.equal(normalizeModelId("MiMo-V2.6-Flash"), "mimo-v2.6-flash");
    assert.equal(normalizeModelId("Kimi K2.7 Code"), "kimi-k2.7-code");
    assert.equal(normalizeModelId("kimi-k3"), "kimi-k3");
    assert.equal(normalizeModelId("DeepSeek V4 Flash Vision Exp"), "deepseek-v4-flash-vision-exp");
  });
});

describe("parsePriceTable", () => {
  it("parses prices keyed by normalized model ID; skips header/separator/free rows", () => {
    const prices = parsePriceTable(MARKDOWN);
    assert.deepEqual(Object.keys(prices).sort(), ["glm-5.3-flash", "kimi-k3"]);
    assert.equal(prices["kimi-k3"].inputPerMtok, 3);
    assert.equal(prices["kimi-k3"].outputPerMtok, 15);
    assert.equal(prices["kimi-k3"].cachedReadPerMtok, 0.3);
    assert.equal(prices["kimi-k3"].cachedWritePerMtok, null);
    assert.equal(prices["kimi-k3"].monthlyLimitUSD, 15);
    assert.equal(prices["glm-5.3-flash"].inputPerMtok, 0.15);
  });

  it("returns {} for garbage or a missing table — never throws", () => {
    assert.deepEqual(parsePriceTable("no table here"), {});
    assert.deepEqual(parsePriceTable(""), {});
  });
});

describe("extractUsage", () => {
  it("extracts tokens, cached breakdown and response id", () => {
    const u = extractUsage(
      completionBody("resp-1", 1_000_000, 500_000, {
        total_tokens: 1_500_000,
        prompt_tokens_details: { cached_tokens: 400_000 },
      }),
    );
    assert.deepEqual(u, {
      responseId: "resp-1",
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      totalTokens: 1_500_000,
      cachedReadTokens: 400_000,
      cachedWriteTokens: null,
    });
  });

  it("derives total from the sum when total_tokens is absent", () => {
    const u = extractUsage(completionBody("resp-2", 300, 70));
    assert.ok(u);
    assert.equal(u.totalTokens, 370);
    assert.equal(u.cachedReadTokens, null);
  });

  it("returns null for malformed bodies — never fabricates usage", () => {
    assert.equal(extractUsage("not json"), null);
    assert.equal(extractUsage("{}"), null);
    assert.equal(extractUsage(JSON.stringify({ usage: null })), null);
    assert.equal(extractUsage(JSON.stringify({ usage: { prompt_tokens: -1, completion_tokens: 5 } })), null);
    assert.equal(extractUsage(JSON.stringify({ usage: { prompt_tokens: "100", completion_tokens: 5 } })), null);
    assert.equal(extractUsage(""), null);
  });
});

describe("isGoUsageDenial", () => {
  it("429 + GoUsageLimitError (type or message) => true", () => {
    assert.equal(isGoUsageDenial({ status: 429, type: "GoUsageLimitError", message: "usage limit reached" }), true);
    assert.equal(isGoUsageDenial({ status: 429, type: "Error", message: "Rate limited: GoUsageLimitError" }), true);
  });

  it("generic 429 or non-429 => false (no exhaustion claim)", () => {
    assert.equal(isGoUsageDenial({ status: 429, type: "Error", message: "too many requests" }), false);
    assert.equal(isGoUsageDenial({ status: 500, type: "GoUsageLimitError", message: "x" }), false);
    assert.equal(isGoUsageDenial({ type: "GoUsageLimitError", message: "x" }), false);
    assert.equal(isGoUsageDenial({ status: 429 }), false);
  });
});

describe("estimateObservationCost", () => {
  const price = { inputPerMtok: 3, outputPerMtok: 15, cachedReadPerMtok: 0.3, cachedWritePerMtok: null, monthlyLimitUSD: 15 };

  it("unknown pricing => null cost, never zero", () => {
    assert.deepEqual(estimateObservationCost({ promptTokens: 1000, completionTokens: 500, cachedReadTokens: null, cachedWriteTokens: null }, undefined), { usd: null, peakRate: true });
    assert.deepEqual(estimateObservationCost({ promptTokens: 1000, completionTokens: 500, cachedReadTokens: null, cachedWriteTokens: null }, { inputPerMtok: null, outputPerMtok: null, cachedReadPerMtok: null, cachedWritePerMtok: null, monthlyLimitUSD: null }), { usd: null, peakRate: true });
  });

  it("peak rate: all prompt tokens at input price when no breakdown", () => {
    const r = estimateObservationCost({ promptTokens: 1_000_000, completionTokens: 500_000, cachedReadTokens: null, cachedWriteTokens: null }, price);
    assert.ok(r.usd !== null);
    assert.ok(Math.abs(r.usd - 10.5) < 1e-9, `got ${r.usd}`); // 3.0 + 7.5
    assert.equal(r.peakRate, true);
  });

  it("applies cached-read discount when the breakdown is present", () => {
    const r = estimateObservationCost({ promptTokens: 1_000_000, completionTokens: 500_000, cachedReadTokens: 400_000, cachedWriteTokens: 0 }, price);
    assert.ok(r.usd !== null);
    // (1e6-4e5)*3/1e6 + 4e5*0.3/1e6 + 5e5*15/1e6 = 1.8 + 0.12 + 7.5 = 9.42
    assert.ok(Math.abs(r.usd - 9.42) < 1e-9, `got ${r.usd}`);
    assert.equal(r.peakRate, false);
  });
});

describe("GoAttribution.observe", () => {
  const T0 = 1_760_000_000_000;

  async function withCatalog(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const storage = new MemStorage();
    const attr = new GoAttribution({ storage, fetchImpl: catalogFetch(calls), now: () => T0, ...overrides });
    assert.equal(await attr.refreshCatalog(), true);
    return { attr, storage, calls };
  }

  it("records a costed observation for a priced Go model", async () => {
    const { attr } = await withCatalog();
    const recorded = await attr.observe({
      providerID: "opencode-go",
      modelId: "kimi-k3",
      response: new Response(completionBody("r1", 1_000_000, 500_000)),
    });
    assert.equal(recorded, true);
    const est = attr.estimates({
      authenticated: true,
      checkedAt: new Date(T0).toISOString(),
      stale: false,
      error: null,
      windows: [],
      availability: "available",
    });
    assert.equal(est["kimi-k3"].observedTokens, 1_500_000);
    assert.ok(Math.abs((est["kimi-k3"].estimatedCostUSD ?? 0) - 10.5) < 1e-9);
    assert.match(est["kimi-k3"].priceProvenance ?? "", /NOT an official quota percentage/);
  });

  it("counts a duplicate response id only once", async () => {
    const { attr } = await withCatalog();
    const body = completionBody("same-id", 1000, 100);
    assert.equal(await attr.observe({ providerID: "opencode-go", modelId: "kimi-k3", response: new Response(body) }), true);
    assert.equal(await attr.observe({ providerID: "opencode-go", modelId: "kimi-k3", response: new Response(body) }), false);
    const est = attr.estimates({ authenticated: true, checkedAt: null, stale: true, error: null, windows: [], availability: "unknown" });
    assert.equal(est["kimi-k3"].observedTokens, 1100);
  });

  it("ignores non-opencode-go responses and unusable bodies", async () => {
    const { attr } = await withCatalog();
    assert.equal(await attr.observe({ providerID: "anthropic", modelId: "claude-x", response: new Response(completionBody("r9", 10, 10)) }), false);
    assert.equal(await attr.observe({ providerID: "opencode-go", modelId: "kimi-k3", response: new Response("not json") }), false);
    assert.equal(
      Object.keys(attr.estimates({ authenticated: true, checkedAt: null, stale: true, error: null, windows: [], availability: "unknown" })).length,
      0,
    );
  });

  it("leaves the original response readable after observing (clone before parse)", async () => {
    const { attr } = await withCatalog();
    const body = completionBody("readable", 500, 250);
    const res = new Response(body);
    await attr.observe({ providerID: "opencode-go", modelId: "kimi-k3", response: res });
    assert.equal(await res.text(), body);
  });

  it("keeps the observation store bounded and releases pruned dedupe ids", async () => {
    const { attr } = await withCatalog({ maxObservations: 3 });
    for (const id of ["a", "b", "c", "d"]) {
      assert.equal(await attr.observe({ providerID: "opencode-go", modelId: "kimi-k3", response: new Response(completionBody(id, 100, 100)) }), true);
    }
    const est = attr.estimates({ authenticated: true, checkedAt: null, stale: true, error: null, windows: [], availability: "unknown" });
    assert.equal(est["kimi-k3"].observedTokens, 3 * 200);
    assert.equal(await attr.observe({ providerID: "opencode-go", modelId: "kimi-k3", response: new Response(completionBody("a", 100, 100)) }), true);
  });

  it("records tokens with null cost for a model without published pricing", async () => {
    const { attr } = await withCatalog();
    await attr.observe({ providerID: "opencode-go", modelId: "mystery-model", response: new Response(completionBody("m1", 1000, 500)) });
    const est = attr.estimates({ authenticated: true, checkedAt: null, stale: true, error: null, windows: [], availability: "unknown" });
    assert.equal(est["mystery-model"].observedTokens, 1500);
    assert.equal(est["mystery-model"].estimatedCostUSD, null);
    assert.equal(est["mystery-model"].priceProvenance, null);
  });
});

describe("GoAttribution denials", () => {
  const T0 = 1_760_000_000_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  async function withState() {
    const storage = new MemStorage();
    const denials: number[] = [];
    const attr = new GoAttribution({
      storage,
      fetchImpl: catalogFetch([]),
      now: () => T0,
      onDenial: (d) => {
        denials.push(d.at);
      },
    });
    assert.equal(await attr.refreshCatalog(), true);
    await attr.observe({ providerID: "opencode-go", modelId: "kimi-k3", response: new Response(completionBody("d1", 1_000_000, 500_000)) });
    await attr.observe({ providerID: "opencode-go", modelId: "space-bunny-free", response: new Response(completionBody("d2", 1000, 100)) });
    return { attr, denials };
  }

  it("a Go-specific 429 flags the shared paid pool and fires the denial callback", async () => {
    const { attr, denials } = await withState();
    const flagged = await attr.onDenial({ status: 429, type: "GoUsageLimitError", message: "weekly limit reached" });
    assert.equal(flagged, true);
    assert.deepEqual(denials, [T0]);
    const est = attr.estimates({
      authenticated: true,
      checkedAt: iso(T0 - 1000),
      stale: false,
      error: null,
      windows: [],
      availability: "limited",
    });
    assert.equal(est["kimi-k3"].effectiveAvailability, "limited");
    assert.equal(est["space-bunny-free"].free, true);
    assert.equal(est["space-bunny-free"].effectiveAvailability, "available", "free models are exempt from the pool flag");
  });

  it("a generic 429 does NOT flag the pool (no exhaustion claim)", async () => {
    const { attr, denials } = await withState();
    assert.equal(await attr.onDenial({ status: 429, type: "Error", message: "too many requests" }), false);
    assert.equal(denials.length, 0);
    const est = attr.estimates({
      authenticated: true,
      checkedAt: iso(T0),
      stale: false,
      error: null,
      windows: [],
      availability: "available",
    });
    assert.equal(est["kimi-k3"].effectiveAvailability, "available");
  });

  it("a fresh authoritative poll after the denial clears the flag", async () => {
    const { attr } = await withState();
    assert.equal(await attr.onDenial({ status: 429, type: "GoUsageLimitError", message: "limit" }), true);
    const fresh: SourceStatus = { authenticated: true, checkedAt: iso(T0 + 5_000), stale: false, error: null, windows: [], availability: "available" };
    assert.equal(attr.denialCurrent(fresh), false);
    assert.equal(attr.estimates(fresh)["kimi-k3"].effectiveAvailability, "available");
  });

  it("stale data after the denial keeps the flag (never a false available)", async () => {
    const { attr } = await withState();
    assert.equal(await attr.onDenial({ status: 429, type: "GoUsageLimitError", message: "limit" }), true);
    const staleAfter: SourceStatus = { authenticated: true, checkedAt: iso(T0 + 5_000), stale: true, error: "authentication failed", windows: [], availability: "unknown" };
    assert.equal(attr.denialCurrent(staleAfter), true);
    assert.equal(attr.estimates(staleAfter)["kimi-k3"].effectiveAvailability, "limited");
  });
});

describe("GoAttribution window attribution", () => {
  const T0 = 1_760_000_000_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("attributes tokens/cost to each window whose nominal span covers the observation", async () => {
    const storage = new MemStorage();
    const clock = { now: T0 };
    const attr = new GoAttribution({ storage, fetchImpl: catalogFetch([]), now: () => clock.now });
    assert.equal(await attr.refreshCatalog(), true);

    await attr.observe({ providerID: "opencode-go", modelId: "kimi-k3", response: new Response(completionBody("w1", 1_000_000, 500_000)) });
    clock.now = T0 - 4 * DAY;
    await attr.observe({ providerID: "opencode-go", modelId: "kimi-k3", response: new Response(completionBody("w2", 2_000_000, 1_000_000)) });
    clock.now = T0;

    const est = attr.estimates({
      authenticated: true,
      checkedAt: iso(T0),
      stale: false,
      error: null,
      windows: [
        { name: "rolling", usedPercent: 50, state: "ok", resetsAt: iso(T0 + 2 * HOUR) },
        { name: "weekly", usedPercent: 40, state: "ok", resetsAt: iso(T0 + 4 * DAY) },
        { name: "monthly", usedPercent: 30, state: "ok", resetsAt: iso(T0 + 10 * DAY) },
        { name: "mystery", usedPercent: 90, state: "rate-limited", resetsAt: null },
      ],
      availability: "available",
    });
    const e = est["kimi-k3"];
    assert.equal(e.observedTokens, 4_500_000, "cumulative over the bounded retention");
    assert.equal(e.byWindow["rolling"]?.observedTokens, 1_500_000);
    assert.equal(e.byWindow["weekly"]?.observedTokens, 1_500_000, "the 4-days-old observation is outside the 7d weekly span");
    assert.equal(e.byWindow["monthly"]?.observedTokens, 4_500_000, "both observations inside the 30d monthly span");
    assert.equal(e.byWindow["mystery"], undefined, "a window without resetsAt is not attributed");
    assert.ok(Math.abs((e.estimatedCostUSD ?? 0) - 31.5) < 1e-9, "10.50 + 21.00 at peak rates");
    assert.ok(Math.abs((e.byWindow["monthly"]?.estimatedCostUSD ?? 0) - 31.5) < 1e-9);
    assert.ok(Math.abs((e.byWindow["rolling"]?.estimatedCostUSD ?? 0) - 10.5) < 1e-9);
  });

  it("marks free models available even while the paid pool is flagged", async () => {
    const storage = new MemStorage();
    const attr = new GoAttribution({ storage, fetchImpl: catalogFetch([]), now: () => T0 });
    assert.equal(await attr.refreshCatalog(), true);
    await attr.observe({ providerID: "opencode-go", modelId: "space-bunny-free", response: new Response(completionBody("f1", 700, 300)) });
    assert.equal(await attr.onDenial({ status: 429, type: "GoUsageLimitError", message: "monthly limit reached" }), true);
    const est = attr.estimates({
      authenticated: true,
      checkedAt: new Date(T0).toISOString(),
      stale: false,
      error: null,
      windows: [],
      availability: "limited",
    });
    assert.equal(est["space-bunny-free"].free, true);
    assert.equal(est["space-bunny-free"].effectiveAvailability, "available");
  });
});

describe("GoAttribution persistence", () => {
  const T0 = 1_760_000_000_000;

  it("hydrates observations, the denial flag and the catalog from storage", async () => {
    const storage = new MemStorage();
    const first = new GoAttribution({ storage, fetchImpl: catalogFetch([]), now: () => T0 });
    assert.equal(await first.refreshCatalog(), true);
    assert.equal(await first.observe({ providerID: "opencode-go", modelId: "kimi-k3", response: new Response(completionBody("p1", 1_000_000, 500_000)) }), true);
    assert.equal(await first.onDenial({ status: 429, type: "GoUsageLimitError", message: "limit" }), true);

    const second = new GoAttribution({ storage, now: () => T0 });
    await second.hydrate();
    const unknown: SourceStatus = { authenticated: true, checkedAt: null, stale: true, error: null, windows: [], availability: "unknown" };
    assert.equal(second.denialCurrent(unknown), true);
    const est = second.estimates(unknown);
    assert.equal(est["kimi-k3"].observedTokens, 1_500_000);
    assert.equal(est["kimi-k3"].estimatedCostUSD, 10.5);
  });
});
