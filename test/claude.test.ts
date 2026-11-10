import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { StatusEngine } from "../src/status.ts";
import { resolveClaudeAuth, resolveClaudeToken } from "../src/claude-auth.ts";
import { CLAUDE_POLL_MS, CLAUDE_PROBE_MS, claudeProvider, parseClaudeUsage } from "../src/providers/claude.ts";
import {
  CLAUDE_PROBE_ERRORS,
  runClaudeProbe,
  type ClaudeProbeOutcome,
  type ClaudeProbeSpawn,
} from "../src/providers/claude-cli.ts";

const T0 = Date.parse("2026-11-03T12:00:00Z");
const PAYLOAD = {
  five_hour: { utilization: 65, resets_at: "2026-11-03T15:00:00.000000+00:00" },
  seven_day: { utilization: 100, resets_at: "2026-11-08T00:00:00+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: "bad" },
};
const reply = (status: number, body: unknown = PAYLOAD) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill(): boolean;
}

/** A fake child process: all output is scripted, nothing is spawned. */
function fakeSpawn(script: (child: FakeChild, close: (code: number | null) => void) => void): ClaudeProbeSpawn {
  return ((_cmd: string, _args: readonly string[], _opts: unknown) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    const close = (code: number | null): void => {
      if (closed) return;
      closed = true;
      child.emit("close", code);
    };
    child.kill = () => {
      close(null);
      return true;
    };
    queueMicrotask(() => script(child, close));
    return child as unknown as ReturnType<ClaudeProbeSpawn>;
  }) as ClaudeProbeSpawn;
}

const rateFrame = (five: unknown, seven: unknown): string => JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: { unifiedWindows: { five_hour: five, seven_day: seven } },
});
const resultFrame = (isError = false): string => JSON.stringify({
  type: "result", is_error: isError, subtype: isError ? "error_during_execution" : "success",
});
const probeOk = (): Promise<ClaudeProbeOutcome> => Promise.resolve({
  windows: [
    { name: "5h", usedPercent: 0, state: "ok", resetsAt: null },
    { name: "7d", usedPercent: 6, state: "ok", resetsAt: null },
  ],
});

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
  let url = ""; let cliRuns = 0;
  await claudeProvider({
    resolveAuth: () => ({ token: "env", source: "env" }),
    fetchImpl: (async (u: unknown) => { url = String(u); return new Response(JSON.stringify(PAYLOAD)); }) as typeof fetch,
    runProbe: async () => { cliRuns++; return probeOk(); },
  }).fetch();
  assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(cliRuns, 0, "no CLI invocation without the opt-in");
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

test("engine: a provider 429 and its cooldown keep the last reading but report unknown availability", async () => {
  // Both probe windows are under 100%, so re-deriving availability would wrongly say "available".
  let t = T0;
  let calls = 0;
  let rateLimited = false;
  const engine = new StatusEngine({
    providers: {
      "claude-agent": claudeProvider({
        probe: true,
        resolveAuth: () => ({ token: "env", source: "env" }),
        now: () => t,
        runProbe: async () => {
          calls++;
          return rateLimited ? { error: CLAUDE_PROBE_ERRORS.exit } : probeOk();
        },
      }),
    },
    now: () => t,
    ttlMs: 60_000,
    sourceTtlMs: { "claude-agent": CLAUDE_POLL_MS },
  });

  const first = await engine.read("claude-agent");
  assert.equal(first.availability, "available");
  assert.equal(calls, 1);

  t += CLAUDE_POLL_MS;
  rateLimited = true;
  const failed = await engine.read("claude-agent");
  assert.equal(calls, 2);
  assert.equal(failed.availability, "unknown", "a 429 must not re-derive availability");
  assert.deepEqual(failed.windows, first.windows, "the last numeric windows are retained");
  assert.equal(failed.checkedAt, first.checkedAt);
  assert.equal(failed.error, CLAUDE_PROBE_ERRORS.exit);

  t += 15_000;
  const cooled = await engine.read("claude-agent");
  assert.equal(calls, 2, "the provider cooldown serves the cache without another request");
  assert.equal(cooled.availability, "unknown");
  assert.deepEqual(cooled.windows, first.windows);
  assert.equal(cooled.checkedAt, first.checkedAt);
  assert.match(cooled.error ?? "", /paused after a failed request/);
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

test("probe: the official client receives only the env token; file-only credentials invoke nothing", async () => {
  let seen: string | undefined;
  const p = claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "file-token", source: "file" }, { token: "env-token", source: "env" }],
    now: () => T0,
    runProbe: async (token) => {
      seen = token;
      return probeOk();
    },
  });
  const s = await p.fetch();
  assert.equal(seen, "env-token", "probe mode never uses the file token");
  assert.equal(s.authenticated, true);
  assert.equal(s.availability, "available");
  assert.ok(!JSON.stringify(s).includes("env-token"));

  let calls = 0;
  const fileOnly = await claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "file", source: "file" }],
    runProbe: async () => {
      calls++;
      return probeOk();
    },
  }).fetch();
  assert.equal(calls, 0);
  assert.equal(fileOnly.checkedAt, null);
});

test("probe: in-memory cadence blocks manual repeated CLI runs", async () => {
  let t = T0; let calls = 0;
  const p = claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "env", source: "env" }],
    now: () => t,
    runProbe: async () => {
      calls++;
      return probeOk();
    },
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

test("probe: CLI failures never retry faster than the cadence", async () => {
  let t = T0; let calls = 0; let fail = true;
  const p = claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "env", source: "env" }],
    now: () => t,
    runProbe: async () => {
      calls++;
      if (fail) throw new Error("offline");
      return probeOk();
    },
  });
  assert.equal((await p.fetch()).checkedAt, null);
  t += 15_000;
  await p.fetch();
  assert.equal(calls, 1, "a failed probe is not retried by the 15s unhealthy path");
  fail = false;
  t += CLAUDE_PROBE_MS - 15_000;
  await p.fetch();
  assert.equal(calls, 2, "the next run waits the full 3 min failure cooldown");
});

test("probe: a CLI failure after success keeps the cached read stale with a canned error", async () => {
  let t = T0; let calls = 0; let fail = false;
  const p = claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "env", source: "env" }],
    now: () => t,
    runProbe: async () => {
      calls++;
      return fail ? { error: CLAUDE_PROBE_ERRORS.timeout } : probeOk();
    },
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

test("probe: the gate is reserved before the CLI run, so a crash cannot allow a second probe", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-probe-")), "gate.json");
  let calls = 0; let releaseProbe: (() => void) | undefined;
  const pending = new Promise<ClaudeProbeOutcome>((resolve) => { releaseProbe = () => resolve(probeOk()); });
  const a = claudeProvider({
    probe: true, resolveAuths: () => [{ token: "env", source: "env" }],
    runProbe: async () => { calls++; return pending; },
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
    runProbe: async () => { secondCalls++; return probeOk(); },
    now: () => T0 + 60_000, probeStateFile: file,
  });
  const blocked = await b.fetch();
  assert.equal(secondCalls, 0, "a recreated provider runs no CLI inside the reserved window");
  assert.equal(blocked.checkedAt, null);

  releaseProbe!();
  assert.equal((await inFlight).windows.length, 2);
});

test("probe: shared gate and in-flight lock cover restarts and parallel instances", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-probe-")), "gate.json");
  let calls = 0; let releaseProbe: (() => void) | undefined;
  const pending = new Promise<ClaudeProbeOutcome>((resolve) => { releaseProbe = () => resolve(probeOk()); });
  const make = (at: number) => claudeProvider({
    probe: true, resolveAuths: () => [{ token: "env", source: "env" }],
    runProbe: async () => { calls++; return pending; }, now: () => at, probeStateFile: file,
  });
  const a = make(T0).fetch();
  await new Promise((r) => setTimeout(r, 20)); // let instance A take the lock
  const b = await make(T0).fetch();
  assert.equal(calls, 1, "a parallel instance cannot probe");
  assert.equal(b.checkedAt, null);
  releaseProbe!();
  const first = await a;
  assert.equal(first.windows.length, 2);
  const restarted = await make(T0).fetch();
  assert.equal(calls, 1, "a restarted instance honours the shared gate");
  assert.equal(restarted.checkedAt, first.checkedAt);
  await make(T0 + CLAUDE_PROBE_MS + 1).fetch();
  assert.equal(calls, 2);
});

test("probe: the canned CLI failure survives the cooldown, a repeated read and a restart on the same gate", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-probe-")), "gate.json");
  let t = T0;
  let calls = 0;
  const make = (at: number) => claudeProvider({
    probe: true, resolveAuths: () => [{ token: "env", source: "env" }],
    runProbe: async () => { calls++; return { error: CLAUDE_PROBE_ERRORS.timeout }; },
    now: () => at, probeStateFile: file,
  });
  const p = make(T0);
  const first = await p.fetch();
  assert.equal(first.error, CLAUDE_PROBE_ERRORS.timeout);
  assert.equal(calls, 1);
  // Same instance, inside the cooldown: keep the cause instead of the generic text.
  t += 15_000;
  const repeated = await p.fetch();
  assert.match(repeated.error ?? "", /paused \(probe CLI timed out\), retry in \d+ min/);
  // A restart on the same gate keeps it too, without another request.
  const restarted = await make(T0 + 30_000).fetch();
  assert.match(restarted.error ?? "", /probe CLI timed out/);
  assert.equal(calls, 1, "no extra probe");
});

test("probe: only canned CLI errors are served from the gate, never an arbitrary stored string", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-probe-")), "gate.json");
  let calls = 0;
  const read = (at: number) => claudeProvider({
    probe: true, resolveAuths: () => [{ token: "env", source: "env" }],
    runProbe: async () => { calls++; return probeOk(); },
    now: () => at, probeStateFile: file,
  }).fetch();
  // Older gates carry no cause: fall back to the generic paused text.
  writeFileSync(file, JSON.stringify({ nextAllowedAt: T0 + 60_000, reason: "cooldown" }));
  assert.match((await read(T0)).error ?? "", /^Claude probe paused, retry in 1 min$/);
  // A tampered gate must not echo its contents back to the caller.
  writeFileSync(file, JSON.stringify({ nextAllowedAt: T0 + 60_000, reason: "cooldown", error: "token sk-live-123" }));
  const tampered = await read(T0);
  assert.doesNotMatch(tampered.error ?? "", /sk-live|token/);
  assert.match(tampered.error ?? "", /^Claude probe paused, retry in 1 min$/);
  // A forged cause token is rejected the same way.
  writeFileSync(file, JSON.stringify({
    nextAllowedAt: T0 + 60_000, reason: "cooldown",
    error: "probe CLI timed out [cause=sk-live]",
  }));
  const forged = await read(T0);
  assert.doesNotMatch(forged.error ?? "", /sk-live/);
  assert.match(forged.error ?? "", /^Claude probe paused, retry in 1 min$/);
  // A real canned CLI error survives a restart.
  writeFileSync(file, JSON.stringify({
    nextAllowedAt: T0 + 60_000, reason: "cooldown", error: CLAUDE_PROBE_ERRORS.output,
  }));
  assert.ok((await read(T0)).error?.includes(CLAUDE_PROBE_ERRORS.output));
  assert.equal(calls, 0, "the gate short-circuits before any CLI run");
});

test("probe: an unwritable reservation or corrupt gate fails closed without running the CLI", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-gate-"));
  const unwritable = path.join(dir, "unwritable.json");
  writeFileSync(unwritable, JSON.stringify({ nextAllowedAt: 0, reason: "cadence" }));
  chmodSync(unwritable, 0o444);
  let runs = 0;
  const p = claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "env", source: "env" }],
    runProbe: async () => { runs++; return probeOk(); },
    now: () => T0,
    probeStateFile: unwritable,
  });
  const failed = await p.fetch();
  assert.equal(runs, 0, "no CLI run when the reservation cannot be persisted");
  assert.equal(failed.checkedAt, null);
  assert.equal(failed.error, "probe gate file is unwritable");
  // The in-memory cadence still holds, so a retry cannot spend inside 3 minutes.
  await p.fetch();
  assert.equal(runs, 0);

  const corrupt = path.join(dir, "corrupt.json");
  writeFileSync(corrupt, "{not json");
  let corruptRuns = 0;
  const c = claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "env", source: "env" }],
    runProbe: async () => { corruptRuns++; return probeOk(); },
    now: () => T0,
    probeStateFile: corrupt,
  });
  assert.equal((await c.fetch()).error, "probe gate file is invalid");
  assert.equal(corruptRuns, 0);
  assert.equal(readFileSync(corrupt, "utf8"), "{not json", "the corrupt gate is not replaced");

  // Valid JSON with an invalid cached status is treated the same way.
  const tampered = path.join(dir, "tampered.json");
  writeFileSync(tampered, JSON.stringify({ nextAllowedAt: 0, reason: "cadence", status: { windows: "no" } }));
  let tamperedRuns = 0;
  const t = claudeProvider({
    probe: true,
    resolveAuths: () => [{ token: "env", source: "env" }],
    runProbe: async () => { tamperedRuns++; return probeOk(); },
    now: () => T0,
    probeStateFile: tampered,
  });
  assert.equal((await t.fetch()).error, "probe gate file is invalid");
  assert.equal(tamperedRuns, 0);

  chmodSync(unwritable, 0o666);
  rmSync(dir, { recursive: true, force: true });
});

test("probe: CLI numeric frames become 5h/7d percentages; missing resets stay null", async () => {
  const outcome = await runClaudeProbe({
    token: "token",
    tempRoot: mkdtempSync(path.join(tmpdir(), "claude-run-")),
    spawnImpl: fakeSpawn((child, close) => {
      child.stdout.write(rateFrame(
        { status: "allowed", utilization: 0 },
        { status: "allowed", utilization: 0.06 },
      ) + "\n");
      child.stdout.write(resultFrame() + "\n");
      child.stdout.end();
      close(0);
    }),
  });
  assert.deepEqual("windows" in outcome && outcome.windows.map((w) => [w.name, w.usedPercent, w.state, w.resetsAt]), [
    ["5h", 0, "ok", null],
    ["7d", 6, "ok", null],
  ]);
});

test("probe: no CLI quota data, malformed output, non-zero exit and timeouts fail closed", async () => {
  const run = (script: (child: FakeChild, close: (code: number | null) => void) => void, timeoutMs?: number) =>
    runClaudeProbe({
      token: "secret-token",
      tempRoot: mkdtempSync(path.join(tmpdir(), "claude-run-")),
      spawnImpl: fakeSpawn(script),
      timeoutMs,
    });

  assert.deepEqual(await run((child, close) => { child.stdout.end(); close(0); }), {
    error: CLAUDE_PROBE_ERRORS.noData,
  });
  assert.deepEqual(await run((child, close) => {
    child.stdout.write("not json secret-token\n"); child.stdout.end(); close(0);
  }), { error: CLAUDE_PROBE_ERRORS.noData });
  assert.deepEqual(await run((child, close) => { child.stdout.end(); close(2); }), {
    error: CLAUDE_PROBE_ERRORS.exit,
  });
  const timedOut = await run(() => { /* never closes */ }, 20);
  assert.deepEqual(timedOut, { error: CLAUDE_PROBE_ERRORS.timeout });
  assert.ok(!JSON.stringify(timedOut).includes("secret-token"));
});

test("probe: oversized CLI output is bounded and fails closed", async () => {
  const outcome = await runClaudeProbe({
    token: "secret-token",
    tempRoot: mkdtempSync(path.join(tmpdir(), "claude-run-")),
    timeoutMs: 100,
    spawnImpl: fakeSpawn((child) => {
      child.stdout.write("x".repeat(1024 * 1024 + 1));
    }),
  });
  assert.deepEqual(outcome, { error: CLAUDE_PROBE_ERRORS.output });
});

test("probe: CLI env/args are isolated, sanitized and carry the token only in the child env", async () => {
  const saved: Record<string, string | undefined> = {};
  const hostile = {
    ANTHROPIC_API_KEY: "secret-api-key",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDECODE: "1",
    CLAUDE_CODE_SIMPLE: "1",
    CLAUDE_CODE_EXTRA_BODY: "secret-body",
    CLAUDE_CODE_BASE_URL: "https://evil.example",
    CLAUDE_CODE_OAUTH_TOKEN: "old-token",
  };
  for (const [k, v] of Object.entries(hostile)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    let command = ""; let args: readonly string[] = []; let options: unknown;
    const root = mkdtempSync(path.join(tmpdir(), "claude-root-"));
    const outcome = await runClaudeProbe({
      token: "new-token",
      tempRoot: root,
      spawnImpl: ((cmd: string, argv: readonly string[], opts: unknown) => {
        command = cmd; args = argv; options = opts;
        const child = new EventEmitter() as FakeChild;
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => false;
        queueMicrotask(() => {
          child.stdout.write(rateFrame({ status: "allowed", utilization: 0.5 }, { status: "allowed", utilization: 0.5 }) + "\n");
          child.stdout.end(); child.emit("close", 0);
        });
        return child as unknown as ReturnType<ClaudeProbeSpawn>;
      }) as ClaudeProbeSpawn,
    });
    assert.ok("windows" in outcome);
    assert.equal(command, process.platform === "win32" ? "claude.exe" : "claude");
    assert.deepEqual(args, [
      "-p", "Reply with OK only.", "--model", "claude-haiku-5-5", "--safe-mode",
      "--no-session-persistence", "--output-format", "stream-json", "--verbose",
      "--max-turns", "1", "--tools", "", "--permission-prompts", "none",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--settings", '{"disableAllHooks":true}',
    ]);
    const o = options as { cwd: string; env: Record<string, string>; shell: boolean; stdio: string[] };
    assert.equal(o.shell, false, "no shell quoting/injection");
    assert.deepEqual(o.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(o.env.CLAUDE_CODE_OAUTH_TOKEN, "new-token");
    assert.equal(o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "16");
    assert.equal(o.env.CLAUDE_CODE_MAX_RETRIES, "0");
    assert.equal(o.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(o.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(o.env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(o.env.CLAUDECODE, undefined);
    assert.equal(o.env.CLAUDE_CODE_SIMPLE, undefined);
    assert.equal(o.env.CLAUDE_CODE_EXTRA_BODY, undefined);
    assert.equal(o.env.CLAUDE_CODE_BASE_URL, undefined);
    assert.equal(o.env.CLAUDE_CONFIG_DIR, path.join(o.cwd, "config"));
    assert.ok(path.resolve(o.cwd).startsWith(path.resolve(root)));
    assert.equal(existsSync(o.cwd), false, "scratch dir removed after the subprocess");
    assert.ok(!JSON.stringify(args).includes("new-token"), "token never appears in argv");
    assert.ok(!JSON.stringify(outcome).includes("new-token"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
