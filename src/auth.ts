// Credential loading for OpenCode Go and Codex.
//
// Sources, in precedence order:
//   1. Explicit overrides (plugin options / env) — never written back anywhere.
//   2. OpenCode 2.x credential DB: <dataDir>/opencode.db, table `credential`, read-only.
//      Data dir: $OPENCODE_DATA or ~/.local/share/opencode (Windows: %USERPROFILE%).
//      DB path override: $OPENCODE_DB (relative paths resolve against the data dir).
//   3. Legacy auth.json in the data dir, when the DB is unreadable.
//
// This module NEVER writes to OpenCode's database and NEVER logs secret values.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A bearer API key credential (OpenCode Go). */
export interface KeyCredential {
  kind: "key";
  key: string;
}

/** An OAuth credential (Codex / ChatGPT). */
export interface OAuthCredential {
  kind: "oauth";
  access: string;
  refresh?: string;
  /** Epoch milliseconds, if reported. */
  expires?: number | null;
  /** Optional account ID from metadata.accountID. */
  accountId?: string | null;
}

export type Credential = KeyCredential | OAuthCredential;

/** Raw row shape as stored in the `credential` table `value` column (JSON). */
type DbValue =
  | { type: "key"; key: string }
  | { type: "oauth"; access: string; refresh?: string; expires?: number | string | null; metadata?: { accountID?: string } };

/** Same map shape as legacy auth.json: integration_id -> value object. */
type AuthJsonMap = Record<string, DbValue>;

export class CredentialError extends Error {}

interface Overrides {
  goKey?: string;
  codexAccess?: string;
  codexAccountId?: string;
}

function dataDir(): string {
  return process.env.OPENCODE_DATA ?? path.join(os.homedir(), ".local", "share", "opencode");
}

function dbPath(): string {
  const override = process.env.OPENCODE_DB;
  if (override) return path.isAbsolute(override) ? override : path.join(dataDir(), override);
  return path.join(dataDir(), "opencode.db");
}

function openDbReadOnly(file: string): DatabaseSync | null {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null; // missing file, corrupt, or node:sqlite unavailable
  }
}

/** Parse a stored credential value into our normalized shape. Returns null on malformed rows. */
export function parseCredentialValue(raw: unknown): Credential | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<DbValue>;
  if (v.type === "key" && typeof v.key === "string" && v.key.length > 0) return { kind: "key", key: v.key };
  if (v.type === "oauth" && typeof v.access === "string" && v.access.length > 0) {
    const cred: OAuthCredential = { kind: "oauth", access: v.access };
    if (typeof v.refresh === "string" && v.refresh.length > 0) cred.refresh = v.refresh;
    if (typeof v.expires === "number") cred.expires = v.expires;
    else if (typeof v.expires === "string" && /^\d+$/.test(v.expires)) cred.expires = Number(v.expires);
    const id = v.metadata?.accountID;
    if (typeof id === "string" && id.length > 0) cred.accountId = id;
    return cred;
  }
  return null;
}

/** Read all credentials from the SQLite DB. Chooses active/latest row per integration. */
function readFromDb(dbFile: string): Map<string, Credential> | null {
  const db = openDbReadOnly(dbFile);
  if (!db) return null;
  try {
    const rows = db
      .prepare("SELECT integration_id, value FROM credential WHERE integration_id IS NOT NULL ORDER BY integration_id, active DESC, time_updated DESC")
      .all() as Array<{ integration_id: string; value: string }>;
    const out = new Map<string, Credential>();
    for (const row of rows) {
      if (out.has(row.integration_id)) continue; // first row wins: active DESC, latest
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        continue;
      }
      const cred = parseCredentialValue(parsed);
      if (cred) out.set(row.integration_id, cred);
    }
    return out.size > 0 ? out : null;
  } finally {
    db.close();
  }
}

/** Fallback: legacy auth.json in the data dir. */
function readFromAuthJson(dir: string): Map<string, Credential> | null {
  const file = path.join(dir, "auth.json");
  if (!existsSync(file)) return null;
  let map: AuthJsonMap;
  try {
    map = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const out = new Map<string, Credential>();
  for (const [id, value] of Object.entries(map)) {
    const cred = parseCredentialValue(value);
    if (cred) out.set(id, cred);
  }
  return out.size > 0 ? out : null;
}

/** Load every credential we can find. Never throws; returns an empty map when nothing is available. */
export function loadCredentials(opts?: { overrides?: Overrides }): Map<string, Credential> {
  const found = new Map<string, Credential>();
  const db = readFromDb(dbPath());
  const source = db ?? readFromAuthJson(dataDir());
  if (source) for (const [id, cred] of source) found.set(id, cred);

  // Explicit overrides win over everything.
  if (opts?.overrides?.goKey) found.set("opencode-go", { kind: "key", key: opts.overrides.goKey });
  if (opts?.overrides?.codexAccess) {
    const existing = found.get("openai");
    found.set("openai", {
      kind: "oauth",
      access: opts.overrides.codexAccess,
      ...(existing && existing.kind === "oauth" ? { refresh: existing.refresh, expires: existing.expires } : {}),
      accountId: opts.overrides.codexAccountId ?? (existing && existing.kind === "oauth" ? existing.accountId : null),
    });
  }
  return found;
}

/** Resolve the OpenCode Go bearer key. */
export function resolveGoKey(found: Map<string, Credential>): string | null {
  const c = found.get("opencode-go");
  return c && c.kind === "key" ? c.key : null;
}

/** Resolve the Codex/ChatGPT OAuth access token + optional account ID. */
export function resolveCodex(found: Map<string, Credential>): { access: string; accountId: string | null } | null {
  for (const id of ["openai", "codex", "chatgpt"]) {
    const c = found.get(id);
    if (c && c.kind === "oauth") return { access: c.access, accountId: c.accountId ?? null };
  }
  return null;
}
