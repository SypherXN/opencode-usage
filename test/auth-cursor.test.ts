import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCursor, loadManagedToken, saveManagedToken } from "../src/cursor-auth.ts";
import type { StorageLike } from "../src/types.ts";

function memStorage(): StorageLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, value); },
    async remove(key) { data.delete(key); },
  };
}

describe("resolveCursor: precedence", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envVars = ["CURSOR_TOKEN", "CURSOR_REFRESH_TOKEN", "CURSOR_TOKEN_FILE", "CURSOR_REFRESH_TOKEN_FILE", "OPENCHAMBER_DATA_DIR"];

  beforeEach(() => {
    for (const v of envVars) { savedEnv[v] = process.env[v]; delete process.env[v]; }
  });
  afterEach(() => {
    for (const v of envVars) {
      if (savedEnv[v] === undefined) delete process.env[v];
      else process.env[v] = savedEnv[v];
    }
  });

  it("override beats env", () => {
    process.env.CURSOR_TOKEN = "env-token";
    const cred = resolveCursor({ cursorToken: "override-token" });
    assert.equal(cred?.source, "override");
    assert.equal(cred?.accessToken, "override-token");
  });

  it("env beats file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-test-"));
    try {
      const tokenFile = path.join(dir, "token.txt");
      writeFileSync(tokenFile, "file-token");
      process.env.CURSOR_TOKEN_FILE = tokenFile;
      process.env.CURSOR_TOKEN = "env-token";
      const cred = resolveCursor();
      assert.equal(cred?.source, "env");
      assert.equal(cred?.accessToken, "env-token");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("file used when no env", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-test-"));
    try {
      const tokenFile = path.join(dir, "token.txt");
      const refreshFile = path.join(dir, "refresh.txt");
      writeFileSync(tokenFile, "file-access");
      writeFileSync(refreshFile, "file-refresh");
      process.env.CURSOR_TOKEN_FILE = tokenFile;
      process.env.CURSOR_REFRESH_TOKEN_FILE = refreshFile;
      const cred = resolveCursor();
      assert.equal(cred?.source, "file");
      assert.equal(cred?.accessToken, "file-access");
      assert.equal(cred?.refreshToken, "file-refresh");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns null when no source available", () => {
    assert.equal(resolveCursor(), null);
  });

  it("unreadable file returns null (no throw)", () => {
    process.env.CURSOR_TOKEN_FILE = "/nonexistent/path/token.txt";
    assert.equal(resolveCursor(), null);
  });

  it("empty file content treated as absent", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-test-"));
    try {
      const tokenFile = path.join(dir, "empty.txt");
      writeFileSync(tokenFile, "");
      process.env.CURSOR_TOKEN_FILE = tokenFile;
      assert.equal(resolveCursor(), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("managed storage round-trip", () => {
  it("save then load", async () => {
    const store = memStorage();
    await saveManagedToken(store, "rotated-access", "rotated-refresh");
    const loaded = await loadManagedToken(store);
    assert.equal(loaded?.accessToken, "rotated-access");
    assert.equal(loaded?.refreshToken, "rotated-refresh");
  });

  it("load from empty storage returns null", async () => {
    const store = memStorage();
    assert.equal(await loadManagedToken(store), null);
  });

  it("malformed stored value returns null", async () => {
    const store = memStorage();
    await store.set("cursor/token", { bogus: true });
    assert.equal(await loadManagedToken(store), null);
  });
});

import { refreshCursorToken, resolveCursorFull, refreshAndPersist } from "../src/cursor-auth.ts";

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }) as unknown as Response;
}

describe("refreshCursorToken", () => {
  it("success: returns new access token", async () => {
    const result = await refreshCursorToken("old-refresh", {
      fetchImpl: mockFetch(200, { access_token: "new-access", refresh_token: "new-refresh" }),
    });
    assert.equal(result?.accessToken, "new-access");
    assert.equal(result?.refreshToken, "new-refresh");
  });

  it("keeps old refresh token when response omits it", async () => {
    const result = await refreshCursorToken("old-refresh", {
      fetchImpl: mockFetch(200, { access_token: "new-access" }),
    });
    assert.equal(result?.accessToken, "new-access");
    assert.equal(result?.refreshToken, null);
  });

  it("shouldLogout returns null", async () => {
    const result = await refreshCursorToken("dead-refresh", {
      fetchImpl: mockFetch(200, { shouldLogout: true }),
    });
    assert.equal(result, null);
  });

  it("401 returns null", async () => {
    const result = await refreshCursorToken("expired", {
      fetchImpl: mockFetch(401, {}),
    });
    assert.equal(result, null);
  });

  it("network failure returns null (no throw)", async () => {
    const result = await refreshCursorToken("tok", {
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    assert.equal(result, null);
  });

  it("malformed JSON returns null", async () => {
    const result = await refreshCursorToken("tok", {
      fetchImpl: async () => new Response("not json", { status: 200 }) as unknown as Response,
    });
    assert.equal(result, null);
  });
});

describe("resolveCursorFull", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envVars = ["CURSOR_TOKEN", "OPENCHAMBER_DATA_DIR"];
  let openChamberDir = "";
  beforeEach(() => {
    for (const v of envVars) { savedEnv[v] = process.env[v]; delete process.env[v]; }
    openChamberDir = mkdtempSync(path.join(os.tmpdir(), "cursor-full-test-"));
    process.env.OPENCHAMBER_DATA_DIR = openChamberDir;
  });
  afterEach(() => {
    for (const v of envVars) {
      if (savedEnv[v] === undefined) delete process.env[v];
      else process.env[v] = savedEnv[v];
    }
    rmSync(openChamberDir, { recursive: true, force: true });
  });

  it("falls back to managed storage when no static source", async () => {
    const store = memStorage();
    await saveManagedToken(store, "managed-access", "managed-refresh");
    const cred = await resolveCursorFull({ storage: store });
    assert.equal(cred?.source, "managed");
    assert.equal(cred?.accessToken, "managed-access");
  });

  it("static source wins over managed", async () => {
    process.env.CURSOR_TOKEN = "env-wins";
    const store = memStorage();
    await saveManagedToken(store, "managed-loses", null);
    const cred = await resolveCursorFull({ storage: store });
    assert.equal(cred?.source, "env");
    assert.equal(cred?.accessToken, "env-wins");
  });

  it("returns null when nothing available", async () => {
    const store = memStorage();
    assert.equal(await resolveCursorFull({ storage: store }), null);
  });
});

describe("OpenChamber managed credential", () => {
  const vars = ["CURSOR_TOKEN", "CURSOR_REFRESH_TOKEN", "CURSOR_TOKEN_FILE", "CURSOR_REFRESH_TOKEN_FILE", "OPENCHAMBER_DATA_DIR"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of vars) { saved[name] = process.env[name]; delete process.env[name]; }
  });
  afterEach(() => {
    for (const name of vars) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("reads OpenChamber credentials and reuses local rotations until the source changes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-openchamber-"));
    try {
      const file = path.join(dir, "quota", "cursor.json");
      mkdirSync(path.dirname(file), { recursive: true });
      process.env.OPENCHAMBER_DATA_DIR = dir;
      writeFileSync(file, JSON.stringify({ accessToken: "open-access", refreshToken: "open-refresh" }));

      const store = memStorage();
      const original = await resolveCursorFull({ storage: store });
      assert.equal(original?.source, "openchamber");
      assert.equal(original?.accessToken, "open-access");
      assert.ok(original?.sourceFile);
      await saveManagedToken(store, "rotated-access", "rotated-refresh", original.sourceFile);
      assert.equal(readFileSync(file, "utf8"), JSON.stringify({ accessToken: "open-access", refreshToken: "open-refresh" }));

      const cached = await resolveCursorFull({ storage: store });
      assert.equal(cached?.source, "openchamber");
      assert.equal(cached?.accessToken, "rotated-access");
      assert.equal(cached?.refreshToken, "rotated-refresh");

      writeFileSync(file, JSON.stringify({ accessToken: "new-access", refreshToken: "new-refresh" }));
      const changedAt = original.sourceFile.mtimeMs + 5000;
      utimesSync(file, new Date(changedAt), new Date(changedAt));
      const updated = await resolveCursorFull({ storage: store });
      assert.equal(updated?.source, "openchamber");
      assert.equal(updated?.accessToken, "new-access");
      assert.equal(await loadManagedToken(store), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ignores malformed OpenChamber data and falls back to plugin storage", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-openchamber-"));
    try {
      const file = path.join(dir, "quota", "cursor.json");
      mkdirSync(path.dirname(file), { recursive: true });
      process.env.OPENCHAMBER_DATA_DIR = dir;
      writeFileSync(file, "not-json");
      const store = memStorage();
      await saveManagedToken(store, "managed-access", "managed-refresh");
      const cred = await resolveCursorFull({ storage: store });
      assert.equal(cred?.source, "managed");
      assert.equal(cred?.accessToken, "managed-access");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("refreshAndPersist", () => {
  it("persists rotated token to managed storage", async () => {
    const store = memStorage();
    const current = { accessToken: "old", refreshToken: "refresh-abc", source: "env" as const };
    const result = await refreshAndPersist(current, {
      storage: store,
      fetchImpl: mockFetch(200, { access_token: "new-rotated", refresh_token: "new-refresh" }),
    });
    assert.equal(result?.accessToken, "new-rotated");
    assert.equal(result?.source, "managed");
    const loaded = await loadManagedToken(store);
    assert.equal(loaded?.accessToken, "new-rotated");
  });

  it("clears managed storage on refresh failure", async () => {
    const store = memStorage();
    await saveManagedToken(store, "stale-access", "stale-refresh");
    const current = { accessToken: "stale-access", refreshToken: "stale-refresh", source: "managed" as const };
    const result = await refreshAndPersist(current, {
      storage: store,
      fetchImpl: mockFetch(401, {}),
    });
    assert.equal(result, null);
    assert.equal(await loadManagedToken(store), null);
  });

  it("returns null when no refresh token available", async () => {
    const store = memStorage();
    const current = { accessToken: "access-only", refreshToken: null, source: "env" as const };
    const result = await refreshAndPersist(current, { storage: store });
    assert.equal(result, null);
  });
});

describe("security: no token leakage", () => {
  it("source label is never the token value itself", () => {
    const cred = resolveCursor({ cursorToken: "super-secret-value" });
    assert.equal(cred?.source, "override");
    assert.notEqual(cred?.source, "super-secret-value");
  });

  it("refresh error paths return null without exposing token", async () => {
    const result = await refreshCursorToken("my-refresh-secret", {
      fetchImpl: async () => { throw new Error("timeout"); },
    });
    assert.equal(result, null);
  });
});
