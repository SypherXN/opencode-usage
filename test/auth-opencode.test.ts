import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CredentialError,
  loadCredentials,
  parseCredentialValue,
  resolveCodex,
  resolveGoKey,
} from "../src/auth.ts";

void CredentialError;

function makeDb(dir: string, rows: Array<{ id: string; value: unknown; active?: number; time?: number }>): string {
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)");
  for (const r of rows) {
    db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?)").run(r.id, JSON.stringify(r.value), r.active ?? 1, r.time ?? Date.now());
  }
  db.close();
  return file;
}

test("parseCredentialValue: key and oauth shapes", () => {
  assert.deepEqual(parseCredentialValue({ type: "key", key: "oc_sk_x" }), { kind: "key", key: "oc_sk_x" });
  const oauth = parseCredentialValue({
    type: "oauth",
    access: "eyJ",
    refresh: "rt.1",
    expires: "1791320300000",
    metadata: { accountID: "acc-1" },
  });
  assert.deepEqual(oauth, { kind: "oauth", access: "eyJ", refresh: "rt.1", expires: 1791320300000, accountId: "acc-1" });
});

test("parseCredentialValue: malformed rows return null", () => {
  assert.equal(parseCredentialValue(null), null);
  assert.equal(parseCredentialValue({ type: "key" }), null);
  assert.equal(parseCredentialValue({ type: "oauth", access: "" }), null);
  assert.equal(parseCredentialValue({ type: "weird", key: "x" }), null);
});

test("row priority: active DESC then latest wins per integration", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gmua-"));
  const dbFile = makeDb(dir, [
    { id: "opencode-go", value: { type: "key", key: "old-key" }, active: 0, time: 100 },
    { id: "opencode-go", value: { type: "key", key: "new-key" }, active: 1, time: 200 },
    { id: "openai", value: { type: "oauth", access: "tok-a", metadata: { accountID: "A" } }, active: 1, time: 100 },
    { id: "openai", value: { type: "oauth", access: "tok-b", metadata: { accountID: "B" } }, active: 1, time: 200 },
  ]);
  process.env.OPENCODE_DATA = dir;
  delete process.env.OPENCODE_DB;
  try {
    const found = loadCredentials();
    assert.equal(resolveGoKey(found), "new-key");
    assert.deepEqual(resolveCodex(found), { access: "tok-b", accountId: "B" });
  } finally {
    delete process.env.OPENCODE_DATA;
  }
});

test("override precedence: explicit options beat DB values", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gmua-"));
  makeDb(dir, [{ id: "opencode-go", value: { type: "key", key: "db-key" } }]);
  process.env.OPENCODE_DATA = dir;
  delete process.env.OPENCODE_DB;
  try {
    const found = loadCredentials({ overrides: { goKey: "override-key", codexAccess: "ov-access", codexAccountId: "ov-acc" } });
    assert.equal(resolveGoKey(found), "override-key");
    assert.deepEqual(resolveCodex(found), { access: "ov-access", accountId: "ov-acc" });
  } finally {
    delete process.env.OPENCODE_DATA;
  }
});

test("OPENCODE_DB relative override resolves against data dir", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gmua-"));
  const nested = path.join(dir, "custom.db");
  const db = new DatabaseSync(nested);
  db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)");
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?)").run("opencode-go", JSON.stringify({ type: "key", key: "rel-key" }), 1, 1);
  db.close();
  process.env.OPENCODE_DATA = dir;
  process.env.OPENCODE_DB = "custom.db";
  try {
    assert.equal(resolveGoKey(loadCredentials()), "rel-key");
  } finally {
    delete process.env.OPENCODE_DATA;
    delete process.env.OPENCODE_DB;
  }
});

test("legacy auth.json fallback when DB unreadable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gmua-"));
  // No opencode.db at all -> falls back to auth.json.
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({ "opencode-go": { type: "key", key: "json-key" }, openai: { type: "oauth", access: "json-tok", metadata: { accountID: "J" } } }),
  );
  process.env.OPENCODE_DATA = dir;
  delete process.env.OPENCODE_DB;
  try {
    const found = loadCredentials();
    assert.equal(resolveGoKey(found), "json-key");
    assert.deepEqual(resolveCodex(found), { access: "json-tok", accountId: "J" });
  } finally {
    delete process.env.OPENCODE_DATA;
  }
});

test("missing DB and file: empty map, resolvers return null", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gmua-empty-"));
  process.env.OPENCODE_DATA = dir;
  delete process.env.OPENCODE_DB;
  try {
    const found = loadCredentials();
    assert.equal(found.size, 0);
    assert.equal(resolveGoKey(found), null);
    assert.equal(resolveCodex(found), null);
  } finally {
    delete process.env.OPENCODE_DATA;
  }
});

test("no secret material in error paths", () => {
  // Corrupt DB value must not leak the raw row into any thrown message.
  const dir = mkdtempSync(path.join(tmpdir(), "gmua-"));
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)");
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?)").run("opencode-go", "not-json", 1, 1);
  db.close();
  process.env.OPENCODE_DATA = dir;
  delete process.env.OPENCODE_DB;
  try {
    const found = loadCredentials(); // must not throw
    assert.equal(resolveGoKey(found), null);
  } finally {
    delete process.env.OPENCODE_DATA;
  }
});
