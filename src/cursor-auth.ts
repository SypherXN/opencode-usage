// Cursor token resolution and refresh (task #5).
//
// Sources, in precedence order:
//   1. Explicit overrides (plugin options) — cursorToken / cursorRefreshToken.
//   2. Environment: CURSOR_TOKEN, CURSOR_REFRESH_TOKEN.
//   3. Token files: CURSOR_TOKEN_FILE, CURSOR_REFRESH_TOKEN_FILE (path to a file containing the token).
//   4. Plugin-managed storage (ctx.storage key "cursor/token") — last resort.
//
// Windows must NOT depend on macOS state.vscdb.
// Refresh: POST https://api2.cursor.sh/oauth/token with grant_type=refresh_token.
// Rotated tokens persist ONLY to the managed store; env/file sources are never overwritten.
// Token values never appear in errors or status output.

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StorageLike } from "./types.ts";

const REFRESH_URL = "https://api2.cursor.sh/oauth/token";
const CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const TIMEOUT_MS = 15_000;

export interface CursorCredential {
  /** Access token for API calls. */
  accessToken: string;
  /** Refresh token, if available. */
  refreshToken: string | null;
  /** Where the access token came from (for diagnostics, never the value itself). */
  source: "override" | "env" | "file" | "openchamber" | "managed";
  /** Identifies the OpenChamber credential file for a locally cached rotation. */
  sourceFile?: { path: string; mtimeMs: number };
}

export interface CursorAuthOptions {
  /** Explicit access token override (highest precedence). */
  cursorToken?: string;
  /** Explicit refresh token override. */
  cursorRefreshToken?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Managed storage for rotated tokens (optional). */
  storage?: StorageLike;
  /** Injectable clock. */
  now?: () => number;
}

/** Read a token from a file path env var. Returns null when unset or unreadable. */
function readTokenFile(envVar: string): string | null {
  const filePath = process.env[envVar];
  if (!filePath) return null;
  try {
    const content = readFileSync(filePath, "utf8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

function readOpenChamberCredential(): CursorCredential | null {
  const root = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), ".config", "openchamber");
  const file = path.join(root, "quota", "cursor.json");
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const token = (v: unknown) => typeof v === "string" && !/[\r\n]/.test(v) ? v.trim() : "";
    const accessToken = token(value.accessToken);
    const refreshToken = token(value.refreshToken) || null;
    if (!accessToken && !refreshToken) return null;
    return {
      accessToken,
      refreshToken,
      source: "openchamber",
      sourceFile: { path: file, mtimeMs: statSync(file).mtimeMs },
    };
  } catch {
    return null;
  }
}

/** Resolve Cursor credentials from all sources in precedence order. Never throws. */
export function resolveCursor(opts: CursorAuthOptions = {}): CursorCredential | null {
  // 1. Explicit overrides.
  if (opts.cursorToken && opts.cursorToken.length > 0) {
    return {
      accessToken: opts.cursorToken,
      refreshToken: opts.cursorRefreshToken ?? null,
      source: "override",
    };
  }

  // 2. Environment variables.
  const envToken = process.env.CURSOR_TOKEN?.trim();
  if (envToken && envToken.length > 0) {
    const envRefresh = process.env.CURSOR_REFRESH_TOKEN?.trim() || null;
    return { accessToken: envToken, refreshToken: envRefresh, source: "env" };
  }

  // 3. Token files.
  const fileToken = readTokenFile("CURSOR_TOKEN_FILE");
  if (fileToken) {
    const fileRefresh = readTokenFile("CURSOR_REFRESH_TOKEN_FILE");
    return { accessToken: fileToken, refreshToken: fileRefresh, source: "file" };
  }

  // 4. Managed storage (checked by caller via loadManagedToken).
  return null;
}

/** Load a previously-rotated token from managed storage. Returns null when absent. */
export async function loadManagedToken(storage: StorageLike): Promise<{
  accessToken: string;
  refreshToken: string | null;
  sourceFile?: CursorCredential["sourceFile"];
} | null> {
  try {
    const raw = await storage.get("cursor/token");
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.accessToken !== "string" || obj.accessToken.length === 0) return null;
    const sourceFile = obj.sourceFile as CursorCredential["sourceFile"] | undefined;
    const validSourceFile = sourceFile && typeof sourceFile.path === "string" && Number.isFinite(sourceFile.mtimeMs)
      ? sourceFile
      : undefined;
    return {
      accessToken: obj.accessToken,
      refreshToken: typeof obj.refreshToken === "string" ? obj.refreshToken : null,
      ...(validSourceFile ? { sourceFile: validSourceFile } : {}),
    };
  } catch {
    return null;
  }
}

/** Persist a rotated token to managed storage. Only called after a successful refresh. */
export async function saveManagedToken(
  storage: StorageLike,
  accessToken: string,
  refreshToken: string | null,
  sourceFile?: CursorCredential["sourceFile"],
): Promise<void> {
  await storage.set("cursor/token", { accessToken, refreshToken, ...(sourceFile ? { sourceFile } : {}) });
}

/**
 * Attempt to refresh the Cursor access token using the refresh token.
 * Returns the new access token on success, or null on failure.
 * Handles shouldLogout by returning null (caller should clear managed storage).
 */
export async function refreshCursorToken(
  refreshToken: string,
  opts: Pick<CursorAuthOptions, "fetchImpl"> = {},
): Promise<{ accessToken: string; refreshToken: string | null } | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  // shouldLogout means the session is gone entirely.
  if (payload.shouldLogout === true) return null;

  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;

  // Some responses include a new refresh token; keep the old one otherwise.
  const newRefresh = typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
    ? payload.refresh_token
    : null;

  return { accessToken, refreshToken: newRefresh };
}

/**
 * Full credential resolution including managed storage fallback and optional refresh.
 * If the resolved token is stale (caller decides) and a refresh token exists, attempts refresh.
 */
export async function resolveCursorFull(opts: CursorAuthOptions = {}): Promise<CursorCredential | null> {
  // Try static sources first.
  const resolved = resolveCursor(opts);
  if (resolved) return resolved;

  const openchamber = readOpenChamberCredential();
  const managed = opts.storage ? await loadManagedToken(opts.storage) : null;

  // A rotated OpenChamber token is reusable only while its source file is unchanged.
  if (managed?.sourceFile) {
    if (
      openchamber?.sourceFile?.path === managed.sourceFile.path &&
      openchamber.sourceFile.mtimeMs === managed.sourceFile.mtimeMs
    ) return { ...managed, source: "openchamber" };
    try { await opts.storage?.remove("cursor/token"); } catch { /* best effort */ }
  }

  return openchamber ?? (managed ? { ...managed, source: "managed" } : null);
}

/**
 * Refresh and persist a new token. Returns updated credential or null.
 * On shouldLogout/failure, clears managed storage so we don't retry a dead token forever.
 */
export async function refreshAndPersist(
  current: CursorCredential,
  opts: CursorAuthOptions,
): Promise<CursorCredential | null> {
  if (!current.refreshToken) return null;

  const result = await refreshCursorToken(current.refreshToken, opts);
  if (!result) {
    // Clear managed storage on failure to avoid infinite retry of a dead token.
    if (opts.storage) {
      try { await opts.storage.remove("cursor/token"); } catch { /* best effort */ }
    }
    return null;
  }

  // Persist only to managed store — never overwrite env/file sources.
  if (opts.storage) {
    await saveManagedToken(opts.storage, result.accessToken, result.refreshToken ?? current.refreshToken, current.sourceFile);
  }

  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? current.refreshToken,
    source: current.source === "openchamber" ? "openchamber" : "managed",
    ...(current.sourceFile ? { sourceFile: current.sourceFile } : {}),
  };
}
