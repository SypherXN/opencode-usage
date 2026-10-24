import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCursorUsage, cursorProvider } from "../src/providers/cursor.ts";

const FULL_PAYLOAD = {
  enabled: true,
  planUsage: {
    totalPercentUsed: 42.5,
    limit: 30000, // $300.00 plan limit in cents
    remaining: 15000, // $150.00 left
    totalSpend: 14999,
    autoPercentUsed: 10,
    apiPercentUsed: 0.5,
  },
  spendLimitUsage: {
    individualLimit: 10000,
    individualRemaining: 2500,
  },
  billingCycleEnd: "2026-10-01T00:00:00Z",
};

const ALLOWED_WINDOW_NAMES = ["auto", "api"];

describe("parseCursorUsage", () => {
  it("normalizes only the auto and API usage bars with cycle reset", () => {
    const windows = parseCursorUsage(FULL_PAYLOAD);
    assert.equal(windows.length, 2);
    const byName = Object.fromEntries(windows.map((w) => [w.name, w]));
    assert.equal(byName.auto.usedPercent, 10);
    assert.equal(byName.api.usedPercent, 0.5);
    for (const w of windows) assert.equal(w.resetsAt, "2026-10-01T00:00:00.000Z");
  });

  it("clamps auto and API bars and marks 100% as rate-limited", () => {
    const windows = parseCursorUsage({
      enabled: true,
      planUsage: { autoPercentUsed: 150, apiPercentUsed: -5 },
    });
    const byName = Object.fromEntries(windows.map((w) => [w.name, w]));
    assert.equal(byName.auto.usedPercent, 100);
    assert.equal(byName.auto.state, "rate-limited");
    assert.equal(byName.api.usedPercent, 0);
    assert.equal(byName.api.state, "ok");
  });

  it("uses billingCycleEnd for auto/api bars and handles epoch or invalid dates", () => {
    const epoch = parseCursorUsage({
      enabled: true,
      planUsage: { autoPercentUsed: 5, apiPercentUsed: 1 },
      billingCycleEnd: 1790000000,
    });
    assert.deepEqual(epoch.map((window) => window.name), ["auto", "api"]);
    assert.ok(epoch[0].resetsAt !== null);
    assert.equal(epoch[0].resetsAt, epoch[1].resetsAt);
    assert.ok(Number.isFinite(new Date(epoch[0].resetsAt!).getTime()));

    const invalid = parseCursorUsage({
      enabled: true,
      planUsage: { autoPercentUsed: 5, apiPercentUsed: 1 },
      billingCycleEnd: "not-a-date",
    });
    assert.equal(invalid.length, 2);
    assert.ok(invalid.every((window) => window.resetsAt === null));
  });

  it("parses numeric-string seconds and milliseconds and falls back to planUsage", () => {
    for (const [value, expected] of [
      ["1790000000", new Date(1790000000 * 1000).toISOString()],
      ["1790000000000", new Date(1790000000000).toISOString()],
    ]) {
      const windows = parseCursorUsage({ planUsage: { autoPercentUsed: 5, apiPercentUsed: 1 }, billingCycleEnd: value });
      assert.ok(windows.every((window) => window.resetsAt === expected));
    }

    const nested = parseCursorUsage({
      planUsage: { autoPercentUsed: 5, apiPercentUsed: 1, billingCycleEnd: "2026-11-01T00:00:00Z" },
    });
    assert.ok(nested.every((window) => window.resetsAt === "2026-11-01T00:00:00.000Z"));
    const rootWins = parseCursorUsage({
      billingCycleEnd: "2026-12-01T00:00:00Z",
      planUsage: { autoPercentUsed: 5, apiPercentUsed: 1, billingCycleEnd: "2026-11-01T00:00:00Z" },
    });
    assert.ok(rootWins.every((window) => window.resetsAt === "2026-12-01T00:00:00.000Z"));
  });

  it("keeps malformed and out-of-range reset values unknown without throwing", () => {
    for (const billingCycleEnd of ["not-a-date", "0", "8640000000000001", 8640000000000001]) {
      const windows = parseCursorUsage({ planUsage: { autoPercentUsed: 5, apiPercentUsed: 1 }, billingCycleEnd });
      assert.equal(windows.length, 2);
      assert.ok(windows.every((window) => window.resetsAt === null));
    }
  });

  it("returns empty when disabled, missing plan usage, or no auto/api bars exist", () => {
    assert.equal(parseCursorUsage({ enabled: false, planUsage: { autoPercentUsed: 50 } }).length, 0);
    assert.equal(parseCursorUsage({ enabled: true }).length, 0);
    assert.equal(parseCursorUsage({ enabled: true, planUsage: null }).length, 0);
    assert.equal(parseCursorUsage({ enabled: true, planUsage: { totalPercentUsed: 50, totalSpend: 100 } }).length, 0);
    assert.equal(parseCursorUsage(undefined).length, 0);
    assert.equal(parseCursorUsage(null).length, 0);
    assert.equal(parseCursorUsage({}).length, 0);
  });

  it("emits only the actual auto and API bars", () => {
    const windows = parseCursorUsage(FULL_PAYLOAD);
    for (const w of windows) {
      assert.ok(ALLOWED_WINDOW_NAMES.includes(w.name), `unexpected window name ${w.name}`);
      assert.ok(w.name === "auto" || w.name === "api");
    }
  });
});

const REFRESH_URL = "https://api2.cursor.sh/oauth/token";

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;
}

/** Scripted fetch: returns one canned response per call and records every call. */
function scriptFetch(script: Array<{ status: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = script.shift();
    if (!next) throw new Error("unexpected extra fetch call");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("cursorProvider.fetch", () => {
  it("valid response => authenticated source with ok windows", async () => {
    const provider = cursorProvider({
      accessToken: "test-token",
      fetchImpl: mockFetch(200, FULL_PAYLOAD),
      now: () => 1758900000000,
    });
    const result = await provider.fetch();
    assert.equal(result.authenticated, true);
    assert.equal(result.stale, false);
    assert.equal(result.error, null);
    assert.equal(result.windows.length, 2);
    assert.equal(result.availability, "available");
    assert.equal(result.checkedAt, new Date(1758900000000).toISOString());
  });

  it("returns authoritative reset dates for both windows without estimated flags", async () => {
    const provider = cursorProvider({
      accessToken: "test-token",
      fetchImpl: mockFetch(200, {
        planUsage: { autoPercentUsed: 5, apiPercentUsed: 1 },
        billingCycleEnd: "1790000000",
      }),
    });
    const result = await provider.fetch();
    assert.ok(result.windows.every((window) => window.resetsAt === new Date(1790000000 * 1000).toISOString()));
    assert.ok(result.windows.every((window) => !("resetEstimated" in window)));
  });

  it("sends a Connect-RPC POST with the right URL, headers and body", async () => {
    const { fetchImpl, calls } = scriptFetch([{ status: 200, body: FULL_PAYLOAD }]);
    const provider = cursorProvider({ accessToken: "tok", fetchImpl });
    await provider.fetch();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, "{}");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer tok");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["Connect-Protocol-Version"], "1");
  });

  it("missing credential => unauthenticated unknown, no request made", async () => {
    let called = false;
    const provider = cursorProvider({
      accessToken: null,
      fetchImpl: async () => { called = true; return new Response("{}", { status: 200 }); },
    });
    const result = await provider.fetch();
    assert.equal(called, false);
    assert.equal(result.authenticated, false);
    assert.equal(result.availability, "unknown");
    assert.equal(result.error, "credential not found");
  });

  it("401 => refreshes once, retries, and succeeds with the rotated token", async () => {
    const rotated: Array<{ access: string; refresh: string | null }> = [];
    const { fetchImpl, calls } = scriptFetch([
      { status: 401, body: {} },
      { status: 200, body: { access_token: "new-token" } },
      { status: 200, body: FULL_PAYLOAD },
    ]);
    const provider = cursorProvider({
      accessToken: "stale-token",
      refreshToken: "refresh-1",
      fetchImpl,
      onRotatedToken: (access, refresh) => { rotated.push({ access, refresh }); },
    });
    const result = await provider.fetch();
    assert.equal(result.availability, "available");
    assert.equal(calls.length, 3);
    assert.equal(calls[1].url, REFRESH_URL);
    const refreshBody = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
    assert.equal(refreshBody.grant_type, "refresh_token");
    assert.equal(refreshBody.refresh_token, "refresh-1");
    const retryHeaders = calls[2].init?.headers as Record<string, string>;
    assert.equal(retryHeaders.Authorization, "Bearer new-token");
    assert.deepEqual(rotated, [{ access: "new-token", refresh: "refresh-1" }]);
  });

  it("401 without refresh token => authentication failed, exactly one call", async () => {
    const { fetchImpl, calls } = scriptFetch([{ status: 401, body: {} }]);
    const provider = cursorProvider({ accessToken: "expired", fetchImpl });
    const result = await provider.fetch();
    assert.equal(result.authenticated, true);
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /authentication failed/);
    assert.equal(calls.length, 1);
  });

  it("401 with failing refresh => authentication failed, no retry", async () => {
    const { fetchImpl, calls } = scriptFetch([
      { status: 401, body: {} },
      { status: 400, body: {} },
    ]);
    const provider = cursorProvider({ accessToken: "expired", refreshToken: "dead", fetchImpl });
    const result = await provider.fetch();
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /authentication failed/);
    assert.equal(calls.length, 2);
  });

  it("401 => refresh => 401 again => authentication failed, refresh attempted only once", async () => {
    const { fetchImpl, calls } = scriptFetch([
      { status: 401, body: {} },
      { status: 200, body: { access_token: "new-token" } },
      { status: 401, body: {} },
    ]);
    const provider = cursorProvider({ accessToken: "stale-token", refreshToken: "refresh-1", fetchImpl });
    const result = await provider.fetch();
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /authentication failed/);
    assert.equal(calls.length, 3);
    assert.equal(calls.filter((c) => c.url === REFRESH_URL).length, 1);
  });

  it("other non-2xx => safe error, unknown", async () => {
    const provider = cursorProvider({ accessToken: "tok", fetchImpl: mockFetch(500, {}) });
    const result = await provider.fetch();
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /HTTP 500/);
  });

  it("network failure => unknown, no throw", async () => {
    const provider = cursorProvider({
      accessToken: "tok",
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    const result = await provider.fetch();
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /request failed or timed out/);
  });

  it("malformed JSON => unknown, no throw", async () => {
    const provider = cursorProvider({
      accessToken: "tok",
      fetchImpl: async () => new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }) as unknown as Response,
    });
    const result = await provider.fetch();
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /malformed JSON/);
  });

  it("disabled plan or missing planUsage => no active subscription", async () => {
    const disabled = cursorProvider({ accessToken: "tok", fetchImpl: mockFetch(200, { enabled: false, planUsage: { totalPercentUsed: 50 } }) });
    const r1 = await disabled.fetch();
    assert.equal(r1.availability, "unknown");
    assert.match(r1.error ?? "", /no active subscription/);

    const noPlan = cursorProvider({ accessToken: "tok", fetchImpl: mockFetch(200, { enabled: true }) });
    const r2 = await noPlan.fetch();
    assert.equal(r2.availability, "unknown");
    assert.match(r2.error ?? "", /no active subscription/);
  });

  it("planUsage without computable percent => could not be parsed", async () => {
    const provider = cursorProvider({ accessToken: "tok", fetchImpl: mockFetch(200, { enabled: true, planUsage: { totalSpend: 100 } }) });
    const result = await provider.fetch();
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /could not be parsed/);
  });

  it("serialized SourceStatus carries no credential material", async () => {
    const provider = cursorProvider({
      accessToken: "super-secret-cursor-token",
      refreshToken: "super-secret-refresh-token",
      fetchImpl: mockFetch(200, FULL_PAYLOAD),
    });
    const result = await provider.fetch();
    const json = JSON.stringify(result);
    assert.ok(!json.includes("super-secret-cursor-token"));
    assert.ok(!json.includes("super-secret-refresh-token"));
    assert.ok(!json.toLowerCase().includes("bearer"));
  });
});
