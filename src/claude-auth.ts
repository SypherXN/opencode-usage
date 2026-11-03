// Claude Code OAuth credential discovery (read-only; never logged or persisted).
//
// Same sources OpenChamber uses, minus the macOS Keychain:
//   1. $CLAUDE_CODE_OAUTH_TOKEN
//   2. <$CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json -> claudeAiOauth.accessToken
// The file is re-read on every call: Claude Code rotates the token.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveClaudeToken(now: number = Date.now()): string | null {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (env) return env;
  const root = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  try {
    const raw = JSON.parse(readFileSync(path.join(root, ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const oauth = raw?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return null;
    // An expired token is useless until Claude Code refreshes it; report not-found.
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) return null;
    return oauth.accessToken;
  } catch {
    return null; // missing or malformed file
  }
}
