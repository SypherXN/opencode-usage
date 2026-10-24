# OpenCode Usage

OpenCode V2 plugin that exposes account quota status for **OpenCode Go**, **Codex (ChatGPT)** and **Cursor** — usage windows, reset times and account-wide availability — through a read-only RPC and a local JSON file.

For OpenCode Go it additionally attributes observed model usage to the **shared, account-wide** Go limits as clearly-labeled **estimates** (observed tokens × published docs pricing). Provider-reported percentages are always authoritative; estimates are never official per-model caps.

## Guarantees

- **Read-only.** Only usage endpoints are polled. Nothing is ever inferred, no model switching, no fallback resets, no quota-consuming probes.
- **Safe failures.** Missing credentials or auth/network errors report `unknown` with a safe message — never a false `available` or `limited`. Secrets never appear in logs, errors or the status document.
- OpenCode's credential database is read **strictly read-only**; nothing is ever written to it.
- **No OpenChamber UI widget.** Consumers (agents, tools, scripts) read the RPC or the JSON file.

## Install

Requirements: **Node ≥ 23.6** (native TypeScript type stripping — no build step), OpenCode V2. A `node:sqlite` experimental warning at load is normal.

Add the package to `plugins` in `opencode.json(c)` (project-local or global at `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      // Relative paths resolve from the config file that contains the entry.
      "package": "./opencode-usage",
      "options": {
        "filePath": "C:/path/to/opencode-usage.json" // optional; see below
      }
    }
  ]
}
```

Alternatively, copy this package into `.opencode/plugins/opencode-usage/` — immediate plugin package directories under `.opencode/plugins/` are loaded automatically (global plugins: `~/.config/opencode/plugins/`).

OpenCode reloads watched config automatically; otherwise run `opencode service restart`. To disable later, add `"-opencode-usage"` to `plugins`.

### Status file location

Precedence: plugin option `filePath` → `$GO_MODEL_USAGE_FILE` → `<project directory>/opencode-usage.json`. The file is written atomically (same-directory temp file + rename); concurrent readers see the full old document, the full new document, or brief absence on Windows — never partial JSON.

## Auth (read-only)

| Source | Where credentials come from |
|---|---|
| OpenCode Go | OpenCode's SQLite credential DB, integration `opencode-go` (type `key`); legacy `auth.json` in the data dir as fallback |
| Codex | Same DB: OAuth credential for integration `openai`, `codex` or `chatgpt` (first match wins); `metadata.accountID` is sent as `ChatGPT-Account-Id` when present |
| Cursor | `$CURSOR_TOKEN` / `$CURSOR_REFRESH_TOKEN` env vars → `$CURSOR_TOKEN_FILE` / `$CURSOR_REFRESH_TOKEN_FILE` token files → OpenChamber's managed `quota/cursor.json` (`$OPENCHAMBER_DATA_DIR`, default `~/.config/openchamber`) → this plugin's managed storage. A 401 refreshes once and retries. No macOS `state.vscdb` dependency (Windows-safe) |

DB location: `$OPENCODE_DATA` (default `~/.local/share/opencode`), file `opencode.db`; `$OPENCODE_DB` overrides the file path (relative paths resolve against the data dir). OpenChamber's Cursor credential file is read-only. Any rotated Cursor token is cached only in this plugin's storage; the cache is reused while the OpenChamber file's modification time is unchanged, and replaced when that file changes. When a source has no credential the plugin still starts and reports `credential not found` / `unknown` for it — it never sends a request without a credential.

## Query status

### JSON file (simplest)

Read the status file (default `<project directory>/opencode-usage.json`):

```sh
type opencode-usage.json   # Windows (PowerShell)
cat opencode-usage.json    # macOS / Linux
```

### RPC

The plugin registers the `opencode-usage` RPC with one `status` method: input `{ refresh?: boolean }` (strict — any other field is rejected), output the versioned status document. From any script with `@opencode/client`:

```ts
import { OpenCode } from "@opencode/client";
import { USAGE_RPC } from "opencode-usage/rpc"; // or a relative import of the plugin's src/rpc.ts

const client = OpenCode.make({ baseUrl: "http://localhost:4096" });
const usage = client.rpc(USAGE_RPC);
const doc = await usage.status({});                  // cached read
const fresh = await usage.status({ refresh: true }); // one rate-limited (60 s) all-source refresh
```

From another plugin: `await ctx.rpc(USAGE_RPC).status({})`. OpenChamber agents/tools can read the RPC or the JSON file — no native widget is provided or promised.

## Freshness and reset semantics

- **~60 s poll cache** shared by every reader (RPC, file, other agents/tools). N concurrent reads coalesce into exactly one upstream fetch; a single background interval drives the loop.
- **Rechecks while capped:** a rate-limited window does not stop polling. The next cache interval rechecks the usage endpoint, so a reset that arrives before the reported `resetsAt` is observed. Availability still comes from the windows that poll returns, so a monthly cap stays limited after a shorter window clears.
- **Cursor reset estimate:** the optional plugin setting `cursorResetAt` supplies a one-time estimated reset when Cursor omits one (for example, set it under the plugin entry's `options`). On a successful poll that observes usage drop from above 0% to exactly 0%, the plugin remembers that UTC day-of-month as `resetDay` and uses it for later monthly estimates. This is a coarse heuristic, not an official Cursor reset time; provider-reported `resetsAt` always wins.
- Freshness is age-based: a source is marked `stale: true` only when no successful poll has landed for 5 minutes, and its availability then becomes `unknown` — stale data never claims current availability or exhaustion.
- A failed poll on its own does not mark a source stale: the last-known windows are kept and reported as `unknown` with a safe `error` (e.g. `authentication failed`, `usage API returned HTTP 500`). Only the age bound above turns the data stale.
- **Faster recheck while unhealthy:** a credentialled source whose last poll attempt failed is retried after ~15 s instead of the full 60 s cache, so a transient auth or network blip clears before the 5-minute age bound. A source capped until a known `resetsAt`, and any healthy source, keep the 60 s cadence. The loop tick is shorter than the cache; each source still fetches at most once per its own interval.
- **Credential re-read on rejection:** when Go or Codex answers 401/403, the plugin re-resolves the credential from the OpenCode credential DB once and retries that request once. An expired Codex session therefore heals itself instead of staying broken until OpenCode restarts; Cursor already refreshes its token and retries once.
- A Go quota denial observed by the plugin (429 + `GoUsageLimitError` via the `retry` hook, scoped to `opencode-go`) triggers one immediate read-only refresh; a generic 429 does not.
- Go windows step 5h rolling → weekly → monthly. Codex and Cursor report only the windows their own APIs report — no Go-style 5h/weekly/monthly windows are invented for them.

## Sample document

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-26T14:00:00.000Z",
  "sources": {
    "go": {
      "authenticated": true,
      "checkedAt": "2026-09-26T14:00:00.000Z",
      "stale": false,
      "error": null,
      "windows": [
        { "name": "rolling", "usedPercent": 42, "state": "ok", "resetsAt": "2026-09-26T19:00:00.000Z" },
        { "name": "weekly", "usedPercent": 12, "state": "ok", "resetsAt": "2026-10-02T14:00:00.000Z" },
        { "name": "monthly", "usedPercent": 8, "state": "ok", "resetsAt": "2026-10-26T14:00:00.000Z" }
      ],
      "availability": "available",
      "nextAvailableAt": null
    },
    "codex": {
      "authenticated": false,
      "checkedAt": null,
      "stale": true,
      "error": "credential not found",
      "windows": [],
      "availability": "unknown",
      "nextAvailableAt": null
    },
    "cursor": {
      "authenticated": true,
      "checkedAt": "2026-09-26T13:59:58.000Z",
      "stale": false,
      "error": null,
      "windows": [
        { "name": "auto", "usedPercent": 10, "state": "ok", "resetsAt": "2026-10-01T00:00:00.000Z" },
        { "name": "api", "usedPercent": 0.5, "state": "ok", "resetsAt": "2026-10-01T00:00:00.000Z" }
      ],
      "availability": "available",
      "nextAvailableAt": null
    }
  },
  "models": {
    "go": {
      "kimi-k3": {
        "observedTokens": 1500,
        "estimatedCostUSD": 0.003,
        "priceProvenance": "estimate only (NOT an official quota percentage): published docs",
        "free": false,
        "effectiveAvailability": "available",
        "byWindow": { "rolling": { "observedTokens": 1500, "estimatedCostUSD": 0.003 } }
      }
    }
  }
}
```

`availability` is account-wide: `limited` when any window is `rate-limited`, `available` when all windows are fresh and `ok`, otherwise `unknown`.
`nextAvailableAt` is the latest reset among rate-limited windows (when all their future reset times are known); it is `null` when not limited or not safely inferable. It can remain known even when the source data is stale.

## Accuracy limits (read before relying on this)

- **Go limits are shared across all paid Go models** (account-wide). Nothing in `models.go` is a per-model cap; `free: true` models bypass the paid pool entirely.
- Per-model `estimatedCostUSD` is an estimate: observed tokens from Go chat-completion responses × published OpenCode docs pricing. Without a cached-token breakdown, tokens bill at peak input rate — a documented upper bound, not a fabrication. `estimatedCostUSD` is `null` when no published price exists.
- Window attribution approximates a window's start as `resetsAt` minus a nominal duration (5h / 7d / 30d); denials near a window boundary may attribute to the previous window.
- Codex window labels derive from the actual `limit_window_seconds` Codex reports; no monthly cap is invented. Cursor windows are only those its API reports.
- Absent or stale data reports `unknown` — absence is never presented as availability or exhaustion.

## Removal

1. Remove the plugin entry from `opencode.json(c)` (or disable with `"-opencode-usage"`) and `opencode service restart`.
2. Delete the status file if you want it gone.
3. The plugin writes nothing to OpenCode's credential database. Its own storage keys (`status/snapshot`, `go/observations`, `go/catalog`, `cursor/token`) live in OpenCode's plugin storage; the only stored credential material is a rotated Cursor refresh token (if rotation ever happened).

## Development & verification

```sh
npm test          # fully mocked: scripted HTTP, fake clock, in-memory storage
npm run typecheck # tsc --noEmit
```

The automated suite makes **no live network calls** and consumes no quota (real SQLite and temp-dir filesystem are used only for the credential-reader and atomic-file tests; everything else is scripted).

Live verification is **opt-in** and manual (read-only, uses your existing auth):

1. Load the plugin as above; `opencode service restart`.
2. After ~60 s read the status file — with a Go credential present, `sources.go.authenticated` should be `true` with a current `checkedAt`.
3. Compare windows against the provider consoles (Go usage page, ChatGPT/Cursor dashboards) — percentages should match the providers' own numbers.
4. Call `usage.status({})` via the RPC snippet above.
