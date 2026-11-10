import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StatusEngine } from "../src/status.ts";
import { resolveClaudeAuth, resolveClaudeToken } from "../src/claude-auth.ts";
import {
  CLAUDE_POLL_MS,
  CLAUDE_PROBE_MS,
  claudeProvider,
  parseClaudeProbeHeaders,
  parseClaudeUsage,
} from "../src/providers/claude.ts";

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
  const p = claudeProvider({ resolveAuth: () => null, fetchImpl: (async () => { calls++; return new Response("{}"); }) as typeof fetch });
  const s = await p.fetch();
  assert.equal(s.checkedAt, null);
  assert.equal(calls, 0);
});

test("provider: probe is off by default, so only the read-only usage endpoint is called", async () => {
  let url = "";
  await claudeProvider({
    resolveAuth: () => ({ token: "env", source: "env" }),
    fetchImpl: (async (u: unknown) => { url = String(u); return new Response(JSON.stringify(PAYLOAD)); }) as typeof fetch,
  }).fetch();
  assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
});

test("provider: success sends bearer + beta header and reports limited", async () => {
  let init: RequestInit | undefined;
  const p = claudeProvider({ resolveAuth: () => ({ token: "tok", source: "env" }),
    now: () => T0,
    fetchImpl: (async (_u: unknown, i: RequestInit) => { init = i; return new Response(JSON.stringify(PAYLOAD)); }) as unknown as typeof fetch,
  });
  const s = await p.fetch();
  assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.equal((init!.headers as Record<string, string>)["anthropic-beta"], "oauth-2025-04-20");
  assert.equal((init!.headers as Record<string, string>)["User-Agent"], undefined, "no forged client header");
  assert.equal(s.availability, "limited");
  assert.equal(s.checkedAt, new Date(T0).toISOString());
  assert.ok(!JSON.stringify(s).includes("tok\""));
});

test("provider: auth/http/parse failures are unknown, never limited", async () => {
  for (const [status, body] of [[401, {}], [500, {}], [200, {}]] as const) {
    const s = await claudeProvider({ resolveAuth: () => ({ token: "t", source: "file" }), fetchImpl: reply(status, body) }).fetch();
    assert.equal(s.checkedAt, null);
    assert.equal(s.availability, "unknown");
    assert.equal(s.authenticated, true);
  }
});

test("token resolution: env token first (static), then the /login credential with its expiry", () => {
  const saved = { c: process.env.CLAUDE_CONFIG_DIR, t: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  try {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const dir = mkdtempSync(path.join(tmpdir(), "claude-auth-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    assert.equal(resolveClaudeToken(T0), null);
    writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: T0 + 1000 } }));
    assert.equal(resolveClaudeAuth(T0)?.source, "file");
    assert.equal(resolveClaudeToken(T0), "a");
    // The long-lived env token wins, even when the /login file still looks valid:
    // its validity is never inferred from that file's timestamp.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env";
    assert.equal(resolveClaudeAuth(T0)?.source, "env");
    assert.equal(resolveClaudeToken(T0), "env");
    assert.equal(resolveClaudeToken(T0 + 2000), "env");
    // With no env token, the /login credential is used exactly as before.
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    assert.equal(resolveClaudeToken(T0), "a");
    assert.equal(resolveClaudeToken(T0 + 2000), null);
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
  const p = claudeProvider({ resolveAuth: () => ({ token: "t", source: "file" }), fetchImpl, now: () => t });
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

test("provider: a long Retry-After is honoured past the old 60 min cap", async () => {
  let t = T0;
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("{}", { status: 429, headers: { "retry-after": "7200" } });
  }) as unknown as typeof fetch;
  const p = claudeProvider({ resolveAuth: () => ({ token: "t", source: "env" }), fetchImpl, now: () => t });
  const first = await p.fetch();
  assert.match(first.error ?? "", /7200s/);
  assert.match(first.error ?? "", /env token/);
  t += 90 * 60_000; // still inside the server's 2 h window
  await p.fetch();
  assert.equal(calls, 1, "must not retry before the server's deadline");
});

test("engine: Claude uses its own slower TTL", async () => {
  let t = T0;
  let calls = 0;
  const provider = { id: "claude-agent" as const, async fetch() {
    calls++;
    return claudeProvider({ resolveAuth: () => ({ token: "t", source: "file" }), now: () => t, fetchImpl: reply(200) }).fetch();
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

test("engine: a passive event without utilization cannot erase a polled percentage", async () => {
  let t = T0;
  const polled = {
    authenticated: true, checkedAt: new Date(T0).toISOString(), stale: false, error: null,
    windows: [{ name: "5h", usedPercent: 65, state: "ok" as const, resetsAt: null }],
    availability: "available" as const, plan: null,
  };
  const engine = new StatusEngine({
    providers: { "claude-agent": { id: "claude-agent", async fetch() { return polled; } } },
    now: () => t,
  });
  await engine.read("claude-agent");
  t += 1000;
  await engine.observe("claude-agent", {
    authenticated: true, checkedAt: new Date(t).toISOString(), stale: false, error: null,
    windows: [{ name: "five_hour", usedPercent: null, state: "ok" as const, resetsAt: "2026-11-10T06:20:00.000Z" }],
    availability: "available" as const, plan: null,
  });
  const after = await engine.read("claude-agent");
  assert.deepEqual(after.windows.map((w) => [w.name, w.usedPercent]), [["5h", 65]]);
});

test("provider: shared gate file stops a second instance from requesting and serves the cached result", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-gate-")), "gate.json");
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response(JSON.stringify(PAYLOAD)); }) as unknown as typeof fetch;
  const a = claudeProvider({ resolveAuth: () => ({ token: "t", source: "file" }), fetchImpl, now: () => T0, stateFile: file });
  const b = claudeProvider({ resolveAuth: () => ({ token: "t", source: "file" }), fetchImpl, now: () => T0 + 30_000, stateFile: file });
  await a.fetch();
  const s = await b.fetch();
  assert.equal(calls, 1);
  assert.equal(s.windows.length, 2);
  const c = claudeProvider({ resolveAuth: () => ({ token: "t", source: "file" }), fetchImpl, now: () => T0 + CLAUDE_POLL_MS + 1_000, stateFile: file });
  await c.fetch();
  assert.equal(calls, 2);
});

test("provider: a 429 is shared across instances", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-gate-")), "gate.json");
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response("{}", { status: 429 }); }) as unknown as typeof fetch;
  await claudeProvider({ resolveAuth: () => ({ token: "t", source: "file" }), fetchImpl, now: () => T0, stateFile: file }).fetch();
  const s = await claudeProvider({ resolveAuth: () => ({ token: "t", source: "file" }), fetchImpl, now: () => T0 + 60_000, stateFile: file }).fetch();
  assert.equal(calls, 1);
  assert.equal(s.checkedAt, null);
});

test("provider: the normal cadence gate serves the cached reading without an error", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-gate-")), "gate.json");
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response(JSON.stringify(PAYLOAD)); }) as unknown as typeof fetch;
  const p = () => claudeProvider({ resolveAuth: () => ({ token: "t", source: "file" }), fetchImpl, now: () => T0, stateFile: file });
  const first = await p().fetch();
  const second = await p().fetch();
  assert.equal(calls, 1, "the second read is served from the gate");
  assert.equal(second.error, null);
  assert.equal(second.stale, false);
  assert.deepEqual(second.windows, first.windows);
});

test("provider: a throttled or rejected env token falls through to the /login token", async () => {
  for (const status of [429, 401] as const) {
    let t = T0;
    const sent: string[] = [];
    const fetchImpl = (async (_u: unknown, i: RequestInit) => {
      const auth = String((i.headers as Record<string, string>).Authorization);
      sent.push(auth);
      return auth === "Bearer env" ? new Response("{}", { status }) : new Response(JSON.stringify(PAYLOAD));
    }) as unknown as typeof fetch;
    const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-chain-")), "gate.json");
    const p = claudeProvider({
      resolveAuths: () => [{ token: "env", source: "env" }, { token: "file", source: "file" }],
      fetchImpl,
      now: () => t,
      stateFile: file,
    });
    const first = await p.fetch();
    assert.equal(first.error, null, `HTTP ${status}: the file token still produced data`);
    assert.deepEqual(first.windows.map((w) => w.name), ["5h", "7d"]);
    assert.deepEqual(sent, ["Bearer env", "Bearer file"]);
    // The env token is blocked, so the next poll skips it entirely.
    t += CLAUDE_POLL_MS + 1000;
    const second = await p.fetch();
    assert.equal(second.error, null);
    assert.deepEqual(sent, ["Bearer env", "Bearer file", "Bearer file"]);
  }
});

test("a present CLAUDE_CODE_OAUTH_TOKEN never yields a stale/unknown status", async () => {
  const saved = { c: process.env.CLAUDE_CONFIG_DIR, t: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-env-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    // An /login credential that expired long ago must not discredit the env token.
    writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: T0 - 90 * 86_400_000 } }));
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token";
    let sent: string | undefined;
    const fetchImpl = (async (_u: unknown, i: RequestInit) => {
      sent = (i.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify(PAYLOAD));
    }) as unknown as typeof fetch;
    const s = await claudeProvider({ resolveAuth: () => resolveClaudeAuth(T0), fetchImpl, now: () => T0 }).fetch();
    assert.equal(sent, "Bearer env-token");
    assert.equal(s.authenticated, true);
    assert.equal(s.stale, false);
    assert.equal(s.error, null);
    assert.equal(s.availability, "limited");
  } finally {
    for (const [k, v] of [["CLAUDE_CONFIG_DIR", saved.c], ["CLAUDE_CODE_OAUTH_TOKEN", saved.t]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

const PROBE_HEADERS = {
  "anthropic-ratelimit-unified-5h-utilization": "0.65",
  "anthropic-ratelimit-unified-5h-reset": "1783180800",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "1",
  "anthropic-ratelimit-unified-7d-reset": "1783713600",
  "anthropic-ratelimit-unified-7d-status": "allowed_warning",
};
const probeReply = (headers: Record<string, string> = PROBE_HEADERS): Response => new Response("", { headers });

test("probe headers: fractions to percent; missing/invalid values stay null/unknown", () => {
  const windows = parseClaudeProbeHeaders(new Headers(PROBE_HEADERS));
  assert.deepEqual(windows.map((w) => [w.name, w.usedPercent, w.state]), [["5h", 65, "ok"], ["7d", 100, "ok"]]);
  assert.equal(windows[0].resetsAt, new Date(1783180800 * 1000).toISOString());
  const odd = parseClaudeProbeHeaders(new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "2",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "bad",
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-overage-status": "allowed",
  }));
  assert.deepEqual(odd.map((w) => [w.name, w.usedPercent, w.state]), [["5h", null, "ok"], ["7d", null, "unknown"]]);
  assert.deepEqual(parseClaudeProbeHeaders(new Headers()), []);
});

test("probe: env-only POST /v1/messages with the exact body and no client spoofing", async () => {
  let url = ""; let init: RequestInit | undefined;
  const p = claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "file-token", source: "file" }, { token: "env-token", source: "env" }],
    now: () => T0,
    fetchImpl: (async (u: unknown, i: RequestInit) => { url = String(u); init = i; return probeReply(); }) as typeof fetch,
  });
  const s = await p.fetch();
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init?.method, "POST");
  const h = init?.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer env-token", "probe mode never sends the file token");
  assert.equal(h["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(h["anthropic-version"], "2023-06-01");
  assert.equal(h["content-type"], "application/json");
  assert.equal(h["User-Agent"], undefined);
  assert.deepEqual(JSON.parse(String(init?.body)), {
    model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "." }],
  });
  assert.equal(s.authenticated, true);
  assert.equal(s.availability, "available");
  assert.ok(!JSON.stringify(s).includes("env-token"));
});

test("probe: file-only credential sends no request", async () => {
  let calls = 0;
  const s = await claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "file", source: "file" }],
    fetchImpl: (async () => { calls++; return probeReply(); }) as unknown as typeof fetch,
  }).fetch();
  assert.equal(calls, 0);
  assert.equal(s.checkedAt, null);
});

test("probe: in-memory cadence blocks manual repeated calls even without a gate file", async () => {
  let t = T0; let calls = 0;
  const p = claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "env", source: "env" }],
    now: () => t,
    fetchImpl: (async () => { calls++; return probeReply(); }) as unknown as typeof fetch,
  });
  const first = await p.fetch();
  const second = await p.fetch();
  assert.equal(calls, 1);
  assert.equal(second.checkedAt, first.checkedAt, "serves the cached probe reading");
  t += CLAUDE_PROBE_MS - 1;
  await p.fetch();
  assert.equal(calls, 1);
  t += 2;
  await p.fetch();
  assert.equal(calls, 2);
});

test("probe: network failures and 429s never retry faster than the cadence", async () => {
  let t = T0; let calls = 0; let mode: "throw" | "429" = "throw";
  const fetchImpl = (async () => {
    calls++;
    if (mode === "throw") throw new Error("offline");
    return new Response("", { status: 429, headers: { "retry-after": "600" } });
  }) as unknown as typeof fetch;
  const p = claudeProvider({ probe: true, resolveAuths: () => [{ token: "env", source: "env" }], now: () => t, fetchImpl });
  assert.equal((await p.fetch()).checkedAt, null);
  t += 15_000;
  await p.fetch();
  assert.equal(calls, 1, "a failed probe is not retried by the 15s unhealthy path");
  t += CLAUDE_PROBE_MS;
  mode = "429";
  assert.match((await p.fetch()).error ?? "", /429/);
  assert.equal(calls, 2);
  t += 4 * 60_000;
  await p.fetch();
  assert.equal(calls, 2, "429 Retry-After is longer than the normal cadence");
  t += 6 * 60_000 + 1_000;
  await p.fetch();
  assert.equal(calls, 3);
});

test("probe: a failure after success keeps the cached read stale with a generic error", async () => {
  let t = T0; let calls = 0; let fail = false;
  const p = claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "env", source: "env" }],
    now: () => t,
    fetchImpl: (async () => {
      calls++;
      if (fail) throw new Error("offline");
      return probeReply();
    }) as unknown as typeof fetch,
  });
  const first = await p.fetch();
  assert.equal(first.windows.length, 2);
  t += CLAUDE_PROBE_MS + 1;
  fail = true;
  assert.equal((await p.fetch()).checkedAt, null);
  assert.equal(calls, 2);
  t += 15_000;
  const cached = await p.fetch();
  assert.equal(calls, 2, "the failed probe is not retried inside the cooldown");
  assert.equal(cached.stale, true);
  assert.match(cached.error ?? "", /paused after a failed request/);
  assert.doesNotMatch(cached.error ?? "", /rate-limit/);
  assert.equal(cached.windows.length, 2, "the last good probe reading is retained");
});

test("probe: the gate is reserved before the request, so a crash cannot allow a second probe", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-probe-")), "gate.json");
  let calls = 0; let releaseFetch: ((r: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => { releaseFetch = resolve; });
  const a = claudeProvider({
    probe: true, resolveAuths: () => [{ token: "env", source: "env" }],
    fetchImpl: (async () => { calls++; return pending; }) as unknown as typeof fetch,
    now: () => T0, probeStateFile: file,
  });
  const inFlight = a.fetch();

  const deadline = Date.now() + 1_000;
  while (!existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  const reserved = JSON.parse(readFileSync(file, "utf8")) as { nextAllowedAt: number };
  assert.ok(reserved.nextAllowedAt >= T0 + CLAUDE_PROBE_MS, "the cadence is persisted before the response");

  // Simulate the owner crashing after the reservation: its lock is gone, but the gate remains.
  unlinkSync(`${file}.lock`);
  let secondCalls = 0;
  const b = claudeProvider({
    probe: true, resolveAuths: () => [{ token: "env", source: "env" }],
    fetchImpl: (async () => { secondCalls++; return probeReply(); }) as unknown as typeof fetch,
    now: () => T0 + 60_000, probeStateFile: file,
  });
  const blocked = await b.fetch();
  assert.equal(secondCalls, 0, "a recreated provider sends no request inside the reserved window");
  assert.equal(blocked.checkedAt, null);

  releaseFetch!(probeReply());
  assert.equal((await inFlight).windows.length, 2);
});

test("probe: shared gate and in-flight lock cover restarts and parallel instances", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-probe-")), "gate.json");
  let calls = 0; let releaseFetch: ((r: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => { releaseFetch = resolve; });
  const fetchImpl = (async () => { calls++; return pending; }) as unknown as typeof fetch;
  const make = (at: number) => claudeProvider({
    probe: true, resolveAuths: () => [{ token: "env", source: "env" }],
    fetchImpl, now: () => at, probeStateFile: file,
  });
  const a = make(T0).fetch();
  await new Promise((r) => setTimeout(r, 20)); // let instance A take the lock
  const b = await make(T0).fetch();
  assert.equal(calls, 1, "a parallel instance cannot probe");
  assert.equal(b.checkedAt, null);
  releaseFetch!(probeReply());
  const first = await a;
  assert.equal(first.windows.length, 2);
  const restarted = await make(T0).fetch();
  assert.equal(calls, 1, "a restarted instance honours the shared gate");
  assert.equal(restarted.checkedAt, first.checkedAt);
  await make(T0 + CLAUDE_PROBE_MS + 1).fetch();
  assert.equal(calls, 2);
});
