// Integration tests for the V2 wiring (task #11 plugin-wiring).
//
// In-process: a fake host captures the RPC/hook registrations, a scripted
// fetch routes the Go usage endpoint (everything else 404s), a fake clock
// drives the TTL/reset-gate math, and a real (throwaway) SQLite file
// supplies the Go credential. No live network, no quota-consuming calls, and
// the environment is scrubbed so the real credential DB is never read.

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime, type PluginRuntimeCtx, type RuntimeDeps } from "../src/index.ts";
import { STATUS_OUTPUT } from "../src/rpc.ts";
import type { StatusSnapshot, StorageLike } from "../src/types.ts";

const T0 = 1_760_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CURSOR_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

/** Healthy account-wide Go windows (rolling/weekly/monthly). */
const GO_OK_BODY = {
  usage: {
    rolling: { percent: 42, resetsAt: iso(T0 + 5 * HOUR) },
    weekly: { percent: 12, resetsAt: iso(T0 + 6 * DAY) },
    monthly: { percent: 8, resetsAt: iso(T0 + 30 * DAY) },
  },
};

/** Capped rolling window (100%) with a 2h reset; weekly/monthly healthy. */
const GO_CAPPED_BODY = {
  usage: {
    rolling: { percent: 100, resetsAt: iso(T0 + 2 * HOUR) },
    weekly: { percent: 12, resetsAt: iso(T0 + 6 * DAY) },
    monthly: { percent: 8, resetsAt: iso(T0 + 30 * DAY) },
  },
};

/** A Go-specific quota denial (429 + GoUsageLimitError) — the only 429 that matters. */
const GO_DENIAL_ERROR = { type: "GoUsageLimitError", message: "Go usage limit reached", status: 429 };

const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

function memStorage(): { storage: StorageLike; data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  const storage: StorageLike = {
    async get(key) {
      return data[key];
    },
    async set(key, value) {
      data[key] = value;
    },
    async remove(key) {
      delete data[key];
    },
  };
  return { storage, data };
}

/** Throwaway OpenCode credential DB with one Go key row (mirrors #2's schema). */
function makeGoDb(dir: string, key: string): string {
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)");
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?)").run(
    "opencode-go",
    JSON.stringify({ type: "key", key }),
    1,
    0,
  );
  db.close();
  return file;
}

// ---- environment scrub (never touch the real credential DB) -----------------

const ENV_KEYS = [
  "OPENCODE_DB",
  "OPENCODE_DATA",
  "GO_MODEL_USAGE_FILE",
  "CURSOR_TOKEN",
  "CURSOR_REFRESH_TOKEN",
  "CURSOR_TOKEN_FILE",
  "CURSOR_REFRESH_TOKEN_FILE",
  "OPENCHAMBER_DATA_DIR",
];

function scrubEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.OPENCHAMBER_DATA_DIR = path.join(tmpdir(), `gmu-openchamber-${process.pid}-${Date.now()}`);
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

// ---- fake host (captures registrations, flags dispose) ----------------------

interface HookEntry {
  name: string;
  providerID?: string;
  callback: (input: unknown) => void | Promise<void>;
  disposed: boolean;
}

interface RpcEntry {
  definition: unknown;
  handlers: Record<string, unknown>;
  disposed: boolean;
}

interface FakeHost {
  ctx: PluginRuntimeCtx;
  hooks: HookEntry[];
  rpcs: RpcEntry[];
}

function makeHost(storage: StorageLike, projectDir: string): FakeHost {
  const hooks: HookEntry[] = [];
  const rpcs: RpcEntry[] = [];
  const ctx: PluginRuntimeCtx = {
    location: { directory: projectDir },
    options: {},
    storage,
    rpc: {
      register: async (definition, handlers) => {
        const entry: RpcEntry = { definition, handlers, disposed: false };
        rpcs.push(entry);
        return {
          dispose: async () => {
            entry.disposed = true;
          },
        };
      },
    },
    session: {
      hook: async (name, callback, options) => {
        const entry: HookEntry = { name, providerID: options?.providerID, callback, disposed: false };
        hooks.push(entry);
        return {
          dispose: async () => {
            entry.disposed = true;
          },
        };
      },
    },
  };
  return { ctx, hooks, rpcs };
}

// ---- scripted fetch (routes the Go usage endpoint; everything else 404s) ----

interface GoState {
  body: unknown;
  status?: number;
}

interface FetchHarness {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
}

function makeFetch(goState: GoState): FetchHarness {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (url === GO_USAGE_URL) {
      const status = goState.status ?? 200;
      return new Response(status === 200 ? JSON.stringify(goState.body) : "", {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

/** Count ONLY Go usage-endpoint calls (catalog/docs fetches are not usage). */
const usageCalls = (f: FetchHarness): number => f.calls.filter((c) => c.url === GO_USAGE_URL).length;

/** Boot the runtime against a fake host; returns host + cleanup. */
async function boot(tmp: string, deps: RuntimeDeps) {
  const { storage } = memStorage();
  const host = makeHost(storage, path.join(tmp, "project"));
  const cleanup = await createRuntime(host.ctx, deps);
  return { host, cleanup, storage };
}

/** Query the status RPC exactly as a consumer would, validating the output. */
async function rpcStatus(host: FakeHost, input: { refresh?: boolean } = {}): Promise<StatusSnapshot> {
  const handler = host.rpcs[0].handlers["status"] as (i: { refresh?: boolean }) => Promise<StatusSnapshot>;
  const doc = await handler(input);
  const res = await STATUS_OUTPUT["~standard"].validate(doc);
  assert.equal(res.issues, undefined, `RPC output must satisfy the contract: ${JSON.stringify(res.issues)}`);
  return doc;
}

const freshTmp = (): string => mkdtempSync(path.join(tmpdir(), "gmua-int-"));

describe("plugin wiring: startup", () => {
  it("starts without any credential: all sources unknown, zero usage requests", async () => {
    const restoreEnv = scrubEnv();
    try {
      const dir = freshTmp();
      process.env.OPENCODE_DATA = path.join(dir, "empty-data"); // no DB, no auth.json
      const clock = { t: T0, now: () => clock.t };
      const f = makeFetch({ body: GO_OK_BODY });
      const filePath = path.join(dir, "usage.json");
      const { host, cleanup } = await boot(dir, {
        fetchImpl: f.fetchImpl,
        now: clock.now,
        ttlMs: 30,
        filePath,
      });

      await settle();
      const doc = await rpcStatus(host);
      for (const id of ["go", "codex", "cursor"] as const) {
        assert.equal(doc.sources[id].authenticated, false);
        assert.equal(doc.sources[id].availability, "unknown");
        assert.deepEqual(doc.sources[id].windows, []);
      }
      assert.equal(doc.sources.go.error, "credential not found");
      assert.equal(usageCalls(f), 0, "no Go usage request without a key");
      assert.ok(!f.calls.some((c) => c.url === CODEX_USAGE_URL || c.url === CURSOR_USAGE_URL));

      // The status file is still published — all-unknown is a valid state.
      const fileDoc = JSON.parse(readFileSync(filePath, "utf8")) as StatusSnapshot;
      assert.equal(fileDoc.schemaVersion, 1);
      assert.equal(fileDoc.sources.go.availability, "unknown");

      await cleanup();
    } finally {
      restoreEnv();
    }
  });
});

describe("plugin wiring: credentialed status flow", () => {
  it("publishes a validated document with authoritative windows and Go estimates", async () => {
    const restoreEnv = scrubEnv();
    try {
      const dir = freshTmp();
      process.env.OPENCODE_DB = makeGoDb(dir, "test-go-key");
      const clock = { t: T0, now: () => clock.t };
      const goState: GoState = { body: GO_OK_BODY };
      const f = makeFetch(goState);
      const filePath = path.join(dir, "usage.json");
      const { host, cleanup } = await boot(dir, {
        fetchImpl: f.fetchImpl,
        now: clock.now,
        ttlMs: 30,
        filePath,
      });

      await settle();
      assert.equal(usageCalls(f), 1, "boot does one coalesced upstream pass");
      const usageCall = f.calls.find((c) => c.url === GO_USAGE_URL);
      assert.ok(usageCall, "the usage endpoint was called");
      const headers = usageCall.init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.["Authorization"], "Bearer test-go-key");

      // A Go completion is observed via the http.response hook (observe-only).
      const respHook = host.hooks.find((h) => h.name === "http.response");
      assert.ok(respHook, "http.response hook registered");
      assert.equal(respHook.providerID, "opencode-go", "hook scoped to the Go provider");
      await respHook.callback({
        model: { providerID: "opencode-go", id: "kimi-k3" },
        response: new Response(
          JSON.stringify({
            id: "resp-1",
            usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      });
      await settle();

      const doc = await rpcStatus(host);
      assert.equal(doc.sources.go.authenticated, true);
      assert.equal(doc.sources.go.availability, "available");
      assert.equal(doc.sources.go.stale, false);
      assert.equal(doc.sources.go.windows.length, 3);
      const est = doc.models.go["kimi-k3"];
      assert.equal(est.observedTokens, 1500);
      assert.equal(est.free, false);

      // The status file matches the RPC document (same schema, same content).
  let fileDoc: StatusSnapshot;
  const publishDeadline = Date.now() + 1_000;
  do {
    fileDoc = JSON.parse(readFileSync(filePath, "utf8")) as StatusSnapshot;
    if (fileDoc.models.go["kimi-k3"]?.observedTokens === 1500) break;
    await settle(10);
  } while (Date.now() < publishDeadline);
  assert.equal(fileDoc.models.go["kimi-k3"]?.observedTokens, 1500, "status file publishes observed Go usage");
  assert.deepEqual(fileDoc.sources, doc.sources);
      assert.deepEqual(fileDoc.models, doc.models);

      await cleanup();
    } finally {
      restoreEnv();
    }
  });
});

describe("plugin wiring: denial and reset gating", () => {
  it("a Go denial triggers one immediate refresh; a later tick rechecks before the reset", async () => {
    const restoreEnv = scrubEnv();
    try {
      const dir = freshTmp();
      process.env.OPENCODE_DB = makeGoDb(dir, "test-go-key");
      const clock = { t: T0, now: () => clock.t };
      const goState: GoState = { body: GO_CAPPED_BODY };
      const f = makeFetch(goState);
      const { host, cleanup } = await boot(dir, { fetchImpl: f.fetchImpl, now: clock.now, ttlMs: 30 });

      await settle();
      assert.equal(usageCalls(f), 1, "boot poll sees the capped rolling window");
      let doc = await rpcStatus(host);
      assert.equal(doc.sources.go.availability, "limited");

      // A Go-specific denial triggers exactly one immediate read-only refresh.
      const retryHook = host.hooks.find((h) => h.name === "retry");
      assert.ok(retryHook, "retry hook registered");
      assert.equal(retryHook.providerID, "opencode-go");
      await retryHook.callback({ error: GO_DENIAL_ERROR });
      await settle();
      assert.equal(usageCalls(f), 2, "denial triggers one immediate refresh");

      // A generic 429 does NOT establish Go exhaustion.
      await retryHook.callback({ error: { type: "RateLimitError", message: "slow down", status: 429 } });
      await settle();
      assert.equal(usageCalls(f), 2, "generic 429 is ignored");

      // TTL long past, and still before the reported reset: the next tick rechecks.
      clock.t = T0 + MIN;
      await settle();
      assert.equal(usageCalls(f), 3, "rechecks before the reported reset");
      doc = await rpcStatus(host);
      assert.equal(doc.sources.go.availability, "limited", "capped window keeps the pool limited (fresh data)");

      // Past the reset the next tick re-fetches before claiming availability.
      goState.body = GO_OK_BODY; // the cap lifts at the reset
      clock.t = T0 + 2 * HOUR + MIN;
      await settle();
      assert.equal(usageCalls(f), 4, "re-polls at/after the reset");
      doc = await rpcStatus(host);
      assert.equal(doc.sources.go.availability, "available");

      await cleanup();
    } finally {
      restoreEnv();
    }
  });

  it("two rapid Go denials coalesce into a single refresh", async () => {
    const restoreEnv = scrubEnv();
    try {
      const dir = freshTmp();
      process.env.OPENCODE_DB = makeGoDb(dir, "test-go-key");
      const clock = { t: T0, now: () => clock.t };
      const f = makeFetch({ body: GO_OK_BODY });
      const { host, cleanup } = await boot(dir, { fetchImpl: f.fetchImpl, now: clock.now, ttlMs: 30 });

      await settle();
      assert.equal(usageCalls(f), 1);
      const retryHook = host.hooks.find((h) => h.name === "retry");
      assert.ok(retryHook, "retry hook registered");
      await Promise.all([
        retryHook.callback({ error: GO_DENIAL_ERROR }),
        retryHook.callback({ error: GO_DENIAL_ERROR }),
      ]);
      await settle();
      assert.equal(usageCalls(f), 2, "both denials coalesced into one upstream refresh");
      const doc = await rpcStatus(host);
      assert.equal(doc.sources.go.availability, "available");

      await cleanup();
    } finally {
      restoreEnv();
    }
  });

  it("a failed denial refresh degrades to unknown and keeps last-known windows", async () => {
    const restoreEnv = scrubEnv();
    try {
      const dir = freshTmp();
      process.env.OPENCODE_DB = makeGoDb(dir, "test-go-key");
      const clock = { t: T0, now: () => clock.t };
      const goState: GoState = { body: GO_OK_BODY };
      const f = makeFetch(goState);
      const { host, cleanup } = await boot(dir, { fetchImpl: f.fetchImpl, now: clock.now, ttlMs: 30 });

      await settle();
      assert.equal(usageCalls(f), 1);
      assert.equal((await rpcStatus(host)).sources.go.availability, "available");

      const retryHook = host.hooks.find((h) => h.name === "retry");
      assert.ok(retryHook, "retry hook registered");
      goState.status = 500; // the denial-triggered refresh now fails
      await retryHook.callback({ error: GO_DENIAL_ERROR });
      await settle();
      assert.equal(usageCalls(f), 2);
      const doc = await rpcStatus(host);
      assert.equal(doc.sources.go.availability, "unknown", "a failed poll never claims availability");
      assert.equal(doc.sources.go.error, "usage API returned HTTP 500");
      assert.equal(doc.sources.go.stale, true);
      assert.equal(doc.sources.go.windows.length, 3, "last-known windows retained");

      await cleanup();
    } finally {
      restoreEnv();
    }
  });
});

describe("plugin wiring: cleanup", () => {
  it("cleanup stops the poll loop and disposes RPC and hook registrations", async () => {
    const restoreEnv = scrubEnv();
    try {
      const dir = freshTmp();
      process.env.OPENCODE_DB = makeGoDb(dir, "test-go-key");
      const clock = { t: T0, now: () => clock.t };
      const f = makeFetch({ body: GO_OK_BODY });
      const { host, cleanup } = await boot(dir, { fetchImpl: f.fetchImpl, now: clock.now, ttlMs: 30 });

      await settle();
      assert.equal(usageCalls(f), 1);

      clock.t = T0 + MIN;
      await settle();
      assert.equal(usageCalls(f), 2, "the loop keeps polling while running");

      await cleanup();
      const after = usageCalls(f);
      clock.t = T0 + 5 * MIN;
      await settle(120);
      assert.equal(usageCalls(f), after, "no polls after cleanup");
      assert.ok(host.hooks.every((h) => h.disposed), "all hooks disposed");
      assert.ok(host.rpcs.every((r) => r.disposed), "RPC registration disposed");
    } finally {
      restoreEnv();
    }
  });
});

describe("plugin wiring: publish isolation", () => {
  it("a failing publish never stops polling or corrupts in-memory status", async () => {
    const restoreEnv = scrubEnv();
    try {
      const dir = freshTmp();
      const blocker = path.join(dir, "blocker");
      writeFileSync(blocker, "x"); // a file where a directory is required => publish must reject
      process.env.OPENCODE_DB = makeGoDb(dir, "test-go-key");
      const clock = { t: T0, now: () => clock.t };
      const f = makeFetch({ body: GO_OK_BODY });
      const { host, cleanup } = await boot(dir, {
        fetchImpl: f.fetchImpl,
        now: clock.now,
        ttlMs: 30,
        filePath: path.join(blocker, "status.json"),
      });

      await settle();
      assert.equal(usageCalls(f), 1, "the boot pass still polls; in-memory state is good");
      assert.ok(!existsSync(path.join(blocker, "status.json")), "no partial file written");
      let doc = await rpcStatus(host);
      assert.equal(doc.sources.go.availability, "available");

      clock.t = T0 + MIN;
      await settle();
      assert.equal(usageCalls(f), 2, "polling continues despite publish failures");
      doc = await rpcStatus(host);
      assert.equal(doc.sources.go.availability, "available");

      await cleanup();
    } finally {
      restoreEnv();
    }
  });
});

// Guard: the wiring must never produce an unhandled promise rejection.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
process.on("unhandledRejection", onUnhandled);

test("no unhandled rejections across the wiring lifecycle", () => {
  process.removeListener("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
});
