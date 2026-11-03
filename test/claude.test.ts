import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StatusEngine } from "../src/status.ts";
import { resolveClaudeToken } from "../src/claude-auth.ts";
import { CLAUDE_POLL_MS, claudeProvider, parseClaudeUsage } from "../src/providers/claude.ts";

const T0 = Date.parse("2026-11-03T12:00:00Z");
const PAYLOAD = {
  five_hour: { utilization: 65, resets_at: "2026-11-03T15:00:00.000000+00:00" },
  seven_day: { utilization: 100, resets_at: "2026-11-08T00:00:00+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: "bad" },
};
const reply = (status: number, body: unknown = PAYLOAD) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("parses windows, clamps, skips null/invalid entries", () => {
  const w = parseClaudeUsage(PAYLOAD);
  assert.deepEqual(w.map((x) => [x.name, x.usedPercent, x.state]), [["5h", 65, "ok"], ["7d", 100, "rate-limited"]]);
  assert.equal(w[0].resetsAt, "2026-11-03T15:00:00.000Z");
  assert.deepEqual(parseClaudeUsage(null), []);
});

test("provider: no credential, no request", async () => {
  let calls = 0;
  const p = claudeProvider({ resolveToken: () => null, fetchImpl: (async () => { calls++; return new Response("{}"); }) as typeof fetch });
  const s = await p.fetch();
  assert.equal(s.checkedAt, null);
  assert.equal(calls, 0);
});

test("provider: success sends bearer + beta header and reports limited", async () => {
  let init: RequestInit | undefined;
  const p = claudeProvider({
    resolveToken: () => "tok",
    now: () => T0,
    fetchImpl: (async (_u: unknown, i: RequestInit) => { init = i; return new Response(JSON.stringify(PAYLOAD)); }) as unknown as typeof fetch,
  });
  const s = await p.fetch();
  assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.equal((init!.headers as Record<string, string>)["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(s.availability, "limited");
  assert.equal(s.checkedAt, new Date(T0).toISOString());
  assert.ok(!JSON.stringify(s).includes("tok\""));
});

test("provider: auth/http/parse failures are unknown, never limited", async () => {
  for (const [status, body] of [[401, {}], [500, {}], [200, {}]] as const) {
    const s = await claudeProvider({ resolveToken: () => "t", fetchImpl: reply(status, body) }).fetch();
    assert.equal(s.checkedAt, null);
    assert.equal(s.availability, "unknown");
    assert.equal(s.authenticated, true);
  }
});

test("token resolution: env, credentials file, expiry", () => {
  const saved = { c: process.env.CLAUDE_CONFIG_DIR, t: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  try {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const dir = mkdtempSync(path.join(tmpdir(), "claude-auth-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    assert.equal(resolveClaudeToken(T0), null);
    writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: T0 + 1000 } }));
    assert.equal(resolveClaudeToken(T0), "a");
    assert.equal(resolveClaudeToken(T0 + 2000), null);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env";
    assert.equal(resolveClaudeToken(T0), "env");
  } finally {
    for (const [k, v] of [["CLAUDE_CONFIG_DIR", saved.c], ["CLAUDE_CODE_OAUTH_TOKEN", saved.t]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("provider: 429 starts a cooldown (Retry-After honoured, min 5 min) with no further requests", async () => {
  let t = T0;
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("{}", { status: 429, headers: { "retry-after": "600" } });
  }) as unknown as typeof fetch;
  const p = claudeProvider({ resolveToken: () => "t", fetchImpl, now: () => t });
  assert.equal((await p.fetch()).checkedAt, null);
  t += 15_000;
  await p.fetch();
  t += 9 * 60_000;
  await p.fetch();
  assert.equal(calls, 1, "no requests during the 10 min Retry-After cooldown");
  t += 2 * 60_000;
  await p.fetch();
  assert.equal(calls, 2);
});

test("engine: Claude uses its own slower TTL", async () => {
  let t = T0;
  let calls = 0;
  const provider = { id: "claude-agent" as const, async fetch() {
    calls++;
    return claudeProvider({ resolveToken: () => "t", now: () => t, fetchImpl: reply(200) }).fetch();
  } };
  const engine = new StatusEngine({ providers: { "claude-agent": provider }, now: () => t, ttlMs: 60_000, sourceTtlMs: { "claude-agent": CLAUDE_POLL_MS } });
  await engine.read("claude-agent");
  t += 2 * 60_000;
  await engine.read("claude-agent");
  assert.equal(calls, 1);
  t += 61_000;
  await engine.read("claude-agent");
  assert.equal(calls, 2);
});
