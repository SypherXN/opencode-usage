// Claude Code OAuth credential discovery (read-only; never logged or persisted).
//
// $CLAUDE_CODE_OAUTH_TOKEN comes FIRST. It is a long-lived token from
// `claude setup-token`, set once as a user environment variable and inherited by
// every process. It is STATIC: no refresh token, ~1 year, and its expiry is not
// recorded anywhere else, so it is never judged by another file's timestamp.
// Only a 401 from a real request disproves it.
//
// Second: the /login credential Claude Code keeps refreshing:
//   <$CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json -> claudeAiOauth.accessToken
// re-read on every call because Claude Code rotates it.
//
// Anthropic API keys, Bedrock/Vertex/Foundry env and apiKeyHelper are deliberately
// skipped: they cannot authorize the OAuth usage endpoint this source reads.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the token came from. Reported in errors so the active source is visible. */
export type ClaudeTokenSource = "env" | "file";

export interface ClaudeAuth {
  token: string;
  source: ClaudeTokenSource;
}

function readFileAuth(now: number): ClaudeAuth | null {
  const root = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  try {
    const raw = JSON.parse(readFileSync(path.join(root, ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const oauth = raw?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return null;
    // An expired /login token is useless until Claude Code refreshes it.
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) return null;
    return { token: oauth.accessToken, source: "file" };
  } catch {
    return null; // missing or malformed file
  }
}

export function resolveClaudeAuths(now: number = Date.now()): ClaudeAuth[] {
  const out: ClaudeAuth[] = [];
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (env) out.push({ token: env, source: "env" });
  const file = readFileAuth(now);
  if (file) out.push(file);
  return out;
}

export function resolveClaudeAuth(now: number = Date.now()): ClaudeAuth | null {
  return resolveClaudeAuths(now)[0] ?? null;
}

export function resolveClaudeToken(now: number = Date.now()): string | null {
  return resolveClaudeAuth(now)?.token ?? null;
}
