import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCodexUsage, resolveWindowLabel, codexProvider } from "../src/providers/codex.ts";

describe("resolveWindowLabel", () => {
  it("labels hours", () => {
    assert.equal(resolveWindowLabel(5 * 3600), "5h");
    assert.equal(resolveWindowLabel(1 * 3600), "1h");
  });
  it("labels days", () => {
    assert.equal(resolveWindowLabel(7 * 86400), "7d");
  });
  it("labels minutes for sub-hour windows", () => {
    assert.equal(resolveWindowLabel(30 * 60), "30m");
  });
  it("returns unknown for null or invalid", () => {
    assert.equal(resolveWindowLabel(null), "unknown");
    assert.equal(resolveWindowLabel(-1), "unknown");
    assert.equal(resolveWindowLabel(0), "unknown");
  });
});

describe("parseCodexUsage", () => {
  it("normalizes both windows with differing durations", () => {
    const payload = {
      rate_limit: {
        primary_window: { limit_window_seconds: 5 * 3600, used_percent: 42, reset_at: "2026-09-26T12:00:00Z" },
        secondary_window: { limit_window_seconds: 7 * 86400, used_percent: 10, reset_at: "2026-09-30T00:00:00Z" },
      },
    };
    const windows = parseCodexUsage(payload);
    assert.equal(windows.length, 2);
    assert.equal(windows[0].name, "primary_5h");
    assert.equal(windows[0].usedPercent, 42);
    assert.equal(windows[0].state, "ok");
    assert.equal(windows[0].resetsAt, "2026-09-26T12:00:00.000Z");
    assert.equal(windows[1].name, "secondary_7d");
    assert.equal(windows[1].usedPercent, 10);
  });

  it("clamps out-of-range percent into [0,100]", () => {
    const payload = {
      rate_limit: {
        primary_window: { limit_window_seconds: 3600, used_percent: 150, reset_at: "2026-09-26T00:00:00Z" },
      },
    };
    const windows = parseCodexUsage(payload);
    assert.equal(windows[0].usedPercent, 100);
  });

  it("drops window with invalid percent (never coerced to zero)", () => {
    const payload = {
      rate_limit: {
        primary_window: { limit_window_seconds: 3600, used_percent: "high", reset_at: "2026-09-26T00:00:00Z" },
      },
    };
    assert.equal(parseCodexUsage(payload).length, 0);
  });

  it("handles missing secondary window", () => {
    const payload = {
      rate_limit: {
        primary_window: { limit_window_seconds: 5 * 3600, used_percent: 50, reset_at: "2026-09-26T00:00:00Z" },
      },
    };
    const windows = parseCodexUsage(payload);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].name, "primary_5h");
  });

  it("handles epoch-seconds reset_at", () => {
    const payload = {
      rate_limit: {
        primary_window: { limit_window_seconds: 3600, used_percent: 10, reset_at: 1758900000 },
      },
    };
    const windows = parseCodexUsage(payload);
    assert.ok(windows[0].resetsAt !== null);
    assert.ok(Number.isFinite(new Date(windows[0]!.resetsAt!).getTime()));
  });

  it("returns empty for absent/malformed payload", () => {
    assert.equal(parseCodexUsage(undefined).length, 0);
    assert.equal(parseCodexUsage(null).length, 0);
    assert.equal(parseCodexUsage({}).length, 0);
    assert.equal(parseCodexUsage({ rate_limit: null }).length, 0);
  });

  it("does not invent a monthly cap — only reported windows appear", () => {
    const payload = {
      rate_limit: {
        primary_window: { limit_window_seconds: 5 * 3600, used_percent: 5, reset_at: "2026-09-26T00:00:00Z" },
      },
    };
    const windows = parseCodexUsage(payload);
    assert.equal(windows.length, 1);
    assert.ok(!windows.some((w) => w.name.includes("monthly")));
  });
});

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }) as unknown as Response;
}

describe("codexProvider.fetch", () => {
  it("valid response => authenticated source with ok windows", async () => {
    const provider = codexProvider({
      accessToken: "test-token",
      accountId: "acct-123",
      fetchImpl: mockFetch(200, {
        rate_limit: {
          primary_window: { limit_window_seconds: 5 * 3600, used_percent: 30, reset_at: "2026-09-26T12:00:00Z" },
          secondary_window: { limit_window_seconds: 7 * 86400, used_percent: 15, reset_at: "2026-09-30T00:00:00Z" },
        },
      }),
      now: () => 1758900000000,
    });
    const result = await provider.fetch();
    assert.equal(result.authenticated, true);
    assert.equal(result.stale, false);
    assert.equal(result.error, null);
    assert.equal(result.windows.length, 2);
    assert.equal(result.availability, "available");
  });

  it("missing credential => unauthenticated unknown, no request made", async () => {
    let called = false;
    const provider = codexProvider({
      accessToken: null,
      fetchImpl: async () => { called = true; return new Response("{}", { status: 200 }); },
    });
    const result = await provider.fetch();
    assert.equal(called, false);
    assert.equal(result.authenticated, false);
    assert.equal(result.availability, "unknown");
    assert.equal(result.error, "credential not found");
  });

  it("401 => authentication failed, unknown (not limited)", async () => {
    const provider = codexProvider({
      accessToken: "expired",
      fetchImpl: mockFetch(401, {}),
    });
    const result = await provider.fetch();
    assert.equal(result.authenticated, true);
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /authentication failed/);
  });

  it("other non-2xx => safe error, unknown", async () => {
    const provider = codexProvider({
      accessToken: "tok",
      fetchImpl: mockFetch(500, {}),
    });
    const result = await provider.fetch();
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /HTTP 500/);
  });

  it("network failure => unknown, no throw", async () => {
    const provider = codexProvider({
      accessToken: "tok",
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    const result = await provider.fetch();
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /request failed or timed out/);
  });

  it("malformed JSON => unknown, no throw", async () => {
    const provider = codexProvider({
      accessToken: "tok",
      fetchImpl: async () => new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }) as unknown as Response,
    });
    const result = await provider.fetch();
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /malformed JSON/);
  });

  it("empty/unparseable usage => unknown, no throw", async () => {
    const provider = codexProvider({
      accessToken: "tok",
      fetchImpl: mockFetch(200, { rate_limit: {} }),
    });
    const result = await provider.fetch();
    assert.equal(result.availability, "unknown");
    assert.match(result.error ?? "", /could not be parsed/);
  });

  it("serialized SourceStatus carries no credential material", async () => {
    const provider = codexProvider({
      accessToken: "super-secret-token-value",
      fetchImpl: mockFetch(200, {
        rate_limit: { primary_window: { limit_window_seconds: 3600, used_percent: 1, reset_at: "2026-09-26T00:00:00Z" } },
      }),
    });
    const result = await provider.fetch();
    const json = JSON.stringify(result);
    assert.ok(!json.includes("super-secret-token-value"));
    assert.ok(!json.toLowerCase().includes("bearer"));
  });
});
