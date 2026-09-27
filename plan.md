# OpenCode Usage — implementation plan

Build an OpenCode V2 plugin exposing OpenCode Go, Codex, and Cursor account quota status and reset times through plugin RPC and a local JSON status file. Estimate Go per-model contributions using observed token usage and published pricing.

**Go limits are shared across all paid Go models**, not per-model. Free Go models bypass paid limits. Provider percentages are authoritative; model costs are estimates, not per-model quota. Codex and Cursor account/plan windows must not be represented as Go's 5h/week/month windows.

All task statuses start `pending`. Each task is scoped for one focused implementation session. Use `/implement-by-id <id> plan.md` to dispatch work; update status only after its acceptance checks pass.

## Task index

| # | id | status | summary | depends on |
|---|---|---|---|---|
| 1 | `plugin-scaffold` | completed | Package, V2 entry, status types | — |
| 2 | `auth-opencode` | completed | OpenCode Go/Codex credentials | #1 |
| 3 | `quota-go` | completed | Go usage endpoint | #1 |
| 4 | `quota-codex` | completed | Codex usage endpoint | #1 |
| 5 | `auth-cursor` | completed | Cursor tokens and refresh | #1 |
| 6 | `quota-cursor` | completed | Cursor usage endpoint | #1, #5 |
| 7 | `status-engine` | completed | Cache, storage, reset gates | #2–#6 |
| 8 | `go-attribution` | completed | Per-model estimates and denials | #3, #7 |
| 9 | `status-rpc` | completed | Read-only status RPC | #7, #8 |
| 10 | `status-file` | completed | Atomic status JSON | #7, #8 |
| 11 | `plugin-wiring` | completed | Integrate lifecycle and polling | #8–#10 |
| 12 | `install-verify` | completed | Docs and integration checks | #11 |

## Implementation order

1. ✅ #1 `plugin-scaffold`
2. ✅ #2 `auth-opencode`; ✅ #3 `quota-go`; ✅ #4 `quota-codex`; ✅ #5 `auth-cursor` (independent after #1)
3. ✅ #6 `quota-cursor`
4. ✅ #7 `status-engine`
5. ✅ #8 `go-attribution`
6. ✅ #9 `status-rpc`; ✅ #10 `status-file` (independent after #8)
7. ✅ #11 `plugin-wiring`; ✅ #12 `install-verify`

## Shared implementation contract

Use OpenCode **V2** docs for actual plugin hooks and RPC signatures: https://opencode.ai/v2/docs/build/plugins and https://opencode.ai/v2/docs/build/plugins/rpc. Candidate APIs: `Plugin.define`, `ctx.storage`, `ctx.session.hook('http.response' | 'retry', ...)`, `ctx.rpc.register` with `Rpc.define`. Verify before coding; do not copy V1 examples.

Versioned snapshot (`schemaVersion: 1`): `updatedAt`, `sources.{go,codex,cursor}` with `checkedAt`, `stale`, safe `error`, `windows` (`name`, `usedPercent`, `state`, `resetsAt`) and `availability: available | limited | unknown`; `models.go[modelID]` with observed tokens, estimated cost when calculable, price provenance and effective shared-pool availability. Absent credentials or stale data must not imply an available or exhausted pool. Never publish tokens, authorization headers, or personal provider payloads.

Suggested files: `package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/auth.ts`, `src/providers/{go,codex,cursor}.ts`, `src/status.ts`, `src/attribution.ts`, `src/publish.ts`, `test/`, `README.md`. Use Node's built-in test runner and mocked HTTP/clock/storage. Avoid quota-consuming test calls.

**Shared read-through cache (design intent for #7/#9/#10):** The status engine is the **single owner of upstream polling**. Many consumers — multiple agents, OpenChamber clients, other tools — may request quota data frequently between the plugin's own ~60s upstream polls. All of them must read from the local cache (via RPC or the status file), **never** by hitting the Go/Codex/Cursor endpoints directly. This bounds upstream request volume to one coalesced poll per window regardless of reader count, protects against provider rate limits, and gives every reader a consistent snapshot at the same freshness. Readers querying more often get cheaper, consistent reads of the same bounded-freshness data — not fresher upstream data. Reset gating (#7) therefore applies globally to the single poll loop, not per consumer.

## Tasks

### [#1] [plugin-scaffold] Package and typed contract

**Num:** 1  
**Status:** completed  
**Priority:** critical  
**Files:** `package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `test/scaffold.test.ts`  
**Depends on:** none

**Scope:** Initialize a minimal TypeScript package, installable OpenCode V2 entry with cleanup, typecheck/test commands and the shared status/adapter types specified above. Establish runtime requirements including read-only SQLite support; do not commit to an unverified plugin hook signature.

**Acceptance criteria:**
- [x] Typecheck/tests run without accounts; plugin loads without configured providers and returns `unknown` states.
- [x] Status contract separates authoritative quota, estimated contribution, errors and freshness; no credential fields.

**Implementation notes (2026-09-26):**
- Node >= 23.6 required (native TS type-stripping for `node --test`; `node:sqlite` built in from 22.13+). No build step; tests import `.ts` directly.
- V2 API verified against live docs + installed `@opencode/plugin` types: `Plugin.define({id, setup(ctx)})` returning a cleanup fn; `ctx.storage.get/set/remove/scan` (value type = effect `Schema.Json`); `ctx.session.hook(name, cb, {providerID?})` incl. `http.response`/`retry`; `ctx.rpc.register(RpcDef, impls)` with `Rpc.define` from `@opencode/plugin/rpc`.
- `StatusSnapshot`/`SourceStatus`/`UsageWindow`/`GoModelEstimate` extend `Record<string, JsonValue>` so they stay assignable to effect `Schema.Json` without casts at storage/RPC call sites.
- Entry persists an initial all-unknown snapshot to `status/snapshot` on load; provider wiring is left to #7–#11 (no hook signatures committed yet).

### [#2] [auth-opencode] Load Go and Codex credentials

**Num:** 2  
**Status:** completed  
**Priority:** high  
**Files:** `src/auth.ts`, `test/auth-opencode.test.ts`  
**Depends on:** #1

**Scope:** Read `opencode-go` key and `openai`/`codex`/`chatgpt` OAuth access with optional `metadata.accountID`. OpenCode 2.x imports `auth.json` into SQLite `<dataDir>/opencode.db`, normally `%USERPROFILE%\.local\share\opencode\opencode.db` on Windows. Respect `OPENCODE_DB` (relative paths relative to data dir); query `credential` read-only, choosing active/latest rows. Fall back to legacy `auth.json` when database unreadable. Document explicit environment overrides. Do not write to OpenCode's database; if `node:sqlite` unavailable, return an actionable error/fallback.

**Acceptance criteria:**
- [x] Tests cover key/OAuth shapes, account ID, row priority, override precedence, missing DB/file and legacy fallback.
- [x] No secret appears in logs, exceptions or status.

**Implementation notes (2026-09-26):**
- `src/auth.ts`: `loadCredentials({overrides?})` reads the SQLite `credential` table read-only (`node:sqlite`, never writes), choosing active/latest row per integration; falls back to legacy `auth.json` when the DB is unreadable. Honors `OPENCODE_DATA` and `OPENCODE_DB` (relative resolves against data dir). Explicit overrides (plugin options/env) beat stored values.
- Resolvers: `resolveGoKey` (integration `opencode-go`, key shape), `resolveCodex` (integrations `openai`/`codex`/`chatgpt`, oauth shape, optional `metadata.accountID`).
- Verified live: real DB at `%USERPROFILE%\.local\share\opencode\opencode.db` contains `opencode-go` (key) and `openai` (oauth with accountID); both resolve correctly without printing secrets.
- 8 new tests (12 total pass); typecheck clean.

### [#3] [quota-go] Fetch shared Go limits

**Num:** 3  
**Status:** completed  
**Priority:** high  
**Files:** `src/providers/go.ts`, `test/go.test.ts`  
**Depends on:** #1

**Scope:** `GET https://opencode.ai/zen/go/v1/usage`, bearer API key, `Accept: application/json`, non-inference session identifier; ~15-second timeout. Normalize `usage.{rolling,weekly,monthly}` entries with `status: ok | rate-limited`, `percent`, `resetsAt`. Distinguish 401/403, 429, timeout, malformed responses. Identify free Go models using verified model metadata or `GET https://opencode.ai/zen/go/v1/models`; unknown model classification remains unknown. Compare current OpenChamber `packages/web/server/lib/quota/providers/opencode-go.js` during implementation.

**Acceptance criteria:**
- [x] Fixtures cover all three windows, absent data, reset parsing, free-model detection and safe failures.
- [x] Requests never invoke a paid model; invalid percentages are not converted to zero.

**Implementation notes (2026-09-26):**
- `src/providers/go.ts` mirrors OpenChamber `opencode-go.js`: `GET https://opencode.ai/zen/go/v1/usage`, bearer key, `Accept: application/json`, `x-opencode-session: openchamber-usage`, `User-Agent: OpenChamber quota provider`, 15s timeout via `AbortSignal.timeout`.
- `parseGoUsage(payload)` normalizes `usage.{rolling,weekly,monthly}` → `UsageWindow[]`; clamps percent into [0,100]; drops non-finite percent (never coerced to zero); invalid `resetsAt` → null but window kept.
- `goProvider({apiKey, fetchImpl?, now?})` returns `{id:"go", fetch()}`. Safe failure matrix: no key → unauthenticated unknown (no request); 401/403 → "authentication failed"; other non-2xx → `HTTP <status>`; network/timeout → "request failed or timed out"; malformed JSON / empty usage → parse errors. All return `unknownSource` (availability `unknown`), never throw.
- Free-model detection: `isFreeGoModel(id, freeIds)` checks a caller-supplied set (live model list owned by #8 attribution). A generic 429 does NOT establish exhaustion.
- 16 tests in `test/go.test.ts`; full suite 28/28 pass; typecheck clean. No credential material in serialized output.

### [#4] [quota-codex] Fetch Codex windows

**Num:** 4  
**Status:** completed  
**Priority:** high  
**Files:** `src/providers/codex.ts`, `test/codex.test.ts`  
**Depends on:** #1

**Scope:** `GET https://chatgpt.com/backend-api/wham/usage` with bearer OAuth access and optional `ChatGPT-Account-Id`. Normalize `rate_limit.primary_window`/`secondary_window` using actual `limit_window_seconds`, `used_percent`, `reset_at`; expose optional `credits` and `spend_control` separately. A primary/secondary label alone does not establish a 5h/week duration. Align with OpenChamber `codex.js`.

**Acceptance criteria:**
- [x] Fixtures cover both windows, differing durations, credits, missing fields, 401 and malformed responses.
- [x] No invented monthly cap; auth/network errors result in `unknown`, not `limited`.

**Implementation notes (2026-09-26):**
- `src/providers/codex.ts` mirrors OpenChamber `codex.js`: `GET https://chatgpt.com/backend-api/wham/usage`, bearer OAuth access, optional `ChatGPT-Account-Id` header, 15s timeout via `AbortSignal.timeout`.
- `parseCodexUsage(payload)` normalizes `rate_limit.{primary_window,secondary_window}` → `UsageWindow[]`; window names derived from ACTUAL `limit_window_seconds` via `resolveWindowLabel` (e.g. "primary_5h", "secondary_7d") — never invents durations from slot labels alone.
- `resolveWindowLabel(seconds)`: checks days first (≥1 day), then hours, then minutes; null/invalid → "unknown".
- `reset_at` accepts ISO strings or epoch seconds (heuristic: <1e12 = seconds).
- Safe failure matrix: no token → unauthenticated unknown (no request); 401 → "authentication failed (session expired)"; other non-2xx → `HTTP <status>`; network/timeout → "request failed or timed out"; malformed JSON / empty rate_limit → parse errors. All return `unknownSource`, never throw.
- Credits/spend_control: parsed from payload but NOT yet surfaced as separate fields in SourceStatus (schema v1 only has windows). Will be added when the status schema evolves to carry provider-specific extras.
- 19 tests in `test/codex.test.ts`; full suite 47/47 pass; typecheck clean. No credential material in serialized output.

### [#5] [auth-cursor] Resolve and refresh Cursor tokens

**Num:** 5  
**Status:** completed  
**Priority:** high  
**Files:** `src/cursor-auth.ts`, `test/auth-cursor.test.ts`  
**Depends on:** #1

**Scope:** Support `CURSOR_TOKEN`, `CURSOR_REFRESH_TOKEN`, corresponding `*_FILE` values, and optional plugin-managed token storage; document precedence. Windows must not depend on macOS `state.vscdb`. When eligible to refresh, POST `https://api2.cursor.sh/oauth/token` with `grant_type: refresh_token`, client ID `KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB`, refresh token. Handle `shouldLogout`. Persist rotated tokens only to a designated managed store; never overwrite env/file sources implicitly.

**Acceptance criteria:**
- [x] Tests cover precedence, token files, refresh success/failure and missing/unwritable sources.
- [x] Token values never appear in status or user-facing errors.

**Implementation notes (2026-09-26):**
- `src/cursor-auth.ts` (separate module to avoid edit conflicts with `src/auth.ts`). Precedence: explicit overrides → `CURSOR_TOKEN`/`CURSOR_REFRESH_TOKEN` env → `CURSOR_TOKEN_FILE`/`CURSOR_REFRESH_TOKEN_FILE` file paths → managed storage (`ctx.storage` key `cursor/token`). No macOS `state.vscdb` dependency.
- Exports: `resolveCursor(opts)` (static sources), `resolveCursorFull(opts)` (adds managed fallback), `loadManagedToken(storage)`, `saveManagedToken(storage, access, refresh)`, `refreshCursorToken(refreshToken, opts)` (POST to `api2.cursor.sh/oauth/token`, handles `shouldLogout`), `refreshAndPersist(current, opts)` (refresh + persist to managed store only; clears managed on failure to avoid infinite retry).
- Rotated tokens persist ONLY to managed storage — env/file sources are never overwritten.
- 23 tests in `test/auth-cursor.test.ts`; full suite 70/70 pass; typecheck clean. No token values in error paths or source labels.

### [#6] [quota-cursor] Fetch Cursor plan usage

**Num:** 6  
**Status:** completed  
**Priority:** high  
**Files:** `src/providers/cursor.ts`, `test/cursor.test.ts`  
**Depends on:** #1, #5

**Scope:** Connect-RPC POST `{}` to `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` with bearer token, JSON content type and `Connect-Protocol-Version: 1`. Normalize `enabled`, `planUsage` percentages and cent-denominated `limit`, `remaining`, `totalSpend`; expose applicable `spendLimitUsage` and `billingCycleEnd`. On 401 refresh once (if possible) and retry once. Add `GetPlanInfo`/`GetCreditGrantsBalance` only for a specific displayed field; verify response variants in OpenChamber `cursor.js`.

**Acceptance criteria:**
- [x] Tests cover plan-usage variants, cents conversion, cycle reset, missing data, token refresh/retry and timeout.
- [x] No fabricated rolling/weekly Cursor limits.

**Implementation notes (2026-09-26):**
- `src/providers/cursor.ts` mirrors OpenChamber `cursor.js` `buildWindows` (fetched live from `openchamber/openchamber` main during implementation): POST `{}` with `Content-Type: application/json` + `Connect-Protocol-Version: 1`, 15s timeout via `AbortSignal.timeout`.
- Windows emitted (names from real response fields only): `billing_cycle` (percent = `totalPercentUsed` if present, else derived from cents `(limit-remaining)/limit*100`), `auto`/`api` (when percents present), `plan_limit` (positive cents limit + remaining), `on_demand` (individual limit with pooled fallback, mirroring OpenChamber). `billingCycleEnd` (ISO or epoch seconds) becomes `resetsAt` on every window.
- A window at 100% used is reported `state: rate-limited` (the provider reports no explicit state field); otherwise `ok`. Invalid/absent percents are dropped, never coerced to zero.
- `enabled === false` or missing `planUsage` → safe error "no active subscription" (mirrors OpenChamber); percent-less `planUsage` → "usage data could not be parsed".
- 401 handling: one refresh (via #5 `refreshCursorToken`) + one retry per fetch call; rotated access/refresh tokens replace internal state and `onRotatedToken` is called for persistence; refresh failure or second 401 → "authentication failed". All safe failures return `unknownSource` (availability `unknown`), never throw.
- `GetPlanInfo`/`GetCreditGrantsBalance` intentionally NOT called: schema v1 has no display fields for plan name or credit balance (plan rule: only for a specific displayed field).
- 23 tests in `test/cursor.test.ts`; full suite 93/93 pass; typecheck clean. No token material in serialized output.

### [#7] [status-engine] Cache, persist, and gate resets

**Num:** 7  
**Status:** completed  
**Priority:** critical  
**Files:** `src/status.ts`, `test/status.test.ts`  
**Depends on:** #2, #3, #4, #5, #6

**Scope:** The engine is the **single owner of upstream polling** — a shared read-through cache that many consumers (multiple agents, OpenChamber clients, other tools) read between the plugin's own ~60s upstream polls. Cache read-only provider polls for ~60 seconds; coalesce concurrent requests so N readers within the TTL produce exactly one upstream fetch, and persist last successful snapshots/reset times via `ctx.storage`. Compute availability from **all** active provider-reported windows. At a reset, expire only that window and re-fetch status before claiming availability; a monthly cap still blocks after a 5h reset. Free Go models remain exempt. A missing reset triggers bounded retry/backoff, never permanent denial. Keep timestamped stale data on auth/network error without claiming current availability. A quota denial may force an immediate safe usage poll. Do not add periodic inference probes.

**Acceptance criteria:**
- [x] Fake-clock tests cover coalescing, restart, overlapping windows, independent resets, absent timestamps and stale snapshots.
- [x] No paid Go model becomes available while any shared Go cap is active; failures never become false available.
- [x] Multiple concurrent readers within the TTL trigger a single upstream fetch per source; readers served from cache never cause additional upstream calls.

**Implementation notes (2026-09-26):**
- `src/status.ts` `StatusEngine` — single owner of upstream polling. API: `read(id)` (read-through), `refresh(id)` (denial trigger, bypasses TTL + reset gates), `readAll()`, `snapshot()` (full versioned doc), `setModelEstimator(fn)` (#8 registers per-model estimates), `hydrate()`, `start()`/`stop()` (background ~60s read-only poll loop, `unref()`'d timer).
- Coalescing: per-source in-flight promise; N concurrent cold readers = exactly one upstream fetch; readers within the TTL (default `POLL_CACHE_MS` 60s) are served from cache with zero upstream calls.
- Reset gating: `gateMs` = the EARLIEST future `resetsAt` among rate-limited windows (a reset re-fetches before claiming availability; a monthly cap still blocks after a 5h reset). A capped window with no valid timestamp contributes a bounded backoff (default 15 min, configurable) instead of a permanent denial.
- Failure handling: a failed poll keeps the last timestamped windows with `stale: true` and `availability: "unknown"` (stale data never claims current availability or exhaustion; enforced centrally in `cached()` — stale ⇒ unknown). Success re-derives availability from ALL windows via `deriveAvailability`.
- Persistence: last snapshot (success or last-known) written to `ctx.storage` key `status/snapshot` after every poll attempt; built straight from the cache so persisting never cascades new polls. `hydrate()` restores per-source cache from that key on restart (skips entries without `checkedAt`).
- No inference probes, no model switching; the loop only polls read-only usage endpoints.
- 14 new tests in `test/status.test.ts` (fake clock + scripted providers + in-memory storage; the one background-loop test uses real timers with a 25ms interval). Full suite 107/107 pass; typecheck clean.

### [#8] [go-attribution] Observe model usage and denials

**Num:** 8  
**Status:** completed  
**Priority:** high  
**Files:** `src/attribution.ts`, `test/attribution.test.ts`  
**Depends on:** #3, #7

**Scope:** Scope V2 `http.response`/`retry` hooks to `opencode-go`. For primary responses, clone before parsing usage; verify actual event/model ID/response shape before building an extractor. If model or token counts are not reliable, report `unknown` rather than fabricating usage. Avoid retry/duplicate counting; persist bounded observations and compute window and cumulative token/cost estimates from verified published model prices (or model metadata). Document pricing date and peak-rate uncertainties. On Go-specific quota denial, flag the **shared paid pool** and force a read-only usage refresh. Generic 429 alone does not establish exhaustion.

**Acceptance criteria:**
- [x] Original response remains readable; duplicate/retry events count once; math and unknown-price handling pass tests.
- [x] Specific denial affects every paid Go model but not free models; estimates never masquerade as official percentages.

**Implementation notes (2026-09-26):** `src/attribution.ts` — `GoAttribution` (provider-scoped to `opencode-go`): `observe()` clones the one-shot `http.response` body before parsing (original stays readable), dedupes by provider response ID, extracts usage via `extractUsage()` (tokens + cached breakdown; missing breakdown → peak input rate, flagged `peakRate`), costs via published pricing from `refreshCatalog()` (docs markdown pricing table + unauth model list; free = normalized ID ends `-free`), and persists a bounded observation ring (default 1000) under storage keys `go/observations` and `go/catalog` (releases pruned dedupe IDs). `onDenial()` flags the shared paid pool only on Go-specific denials (429 + `GoUsageLimitError`), fires the `onDenial` callback (hooked to `engine.refresh("go")` in #11), and is authoritative until a fresh non-stale successful Go poll at/after the denial time; free models are always "available". `estimates()` returns per-model `GoModelEstimateWithWindows`: cumulative tokens/cost over retention plus additive `byWindow` attribution (span = `resetsAt` − nominal duration; windows without `resetsAt` skipped); `priceProvenance` always states "NOT an official quota percentage" with the fetch date; unknown-priced models record tokens with null cost (never zero). 24 tests in `test/attribution.test.ts` (suite 131/131, `tsc --noEmit` clean).

### [#9] [status-rpc] Read-only V2 RPC

**Num:** 9  
**Status:** completed  
**Priority:** medium  
**Files:** `src/rpc.ts` or `src/publish.ts`, `test/rpc.test.ts`  
**Depends on:** #7, #8

**Scope:** Register read-only `usage.status` using V2 `Rpc.define`/`ctx.rpc.register` with validated input/output. Return the versioned schema from the state manager even if one provider has failed or lacks auth. Default to cached reads; an optional manual refresh must be rate-limited. Verify the `@opencode/client` invocation before documenting it. Never accept secrets as RPC input.

**Acceptance criteria:**
- [x] Mock consumer can query status and bad inputs fail validation.
- [x] No provider failure breaks the whole query; response contains no credentials.

**Implementation notes (2026-09-26):** `src/rpc.ts` — `USAGE_RPC = Rpc.define({id: "opencode-usage", methods: {status: {input, output}}, events: {}})` (zod = StandardSchemaV1 portable schemas; `events` is required by `Rpc.Definition`). `STATUS_INPUT` = strict `{refresh?: boolean}` — any other field (secrets included) fails host validation. `STATUS_OUTPUT` mirrors the versioned status contract (`z.literal(1)` schemaVersion, three sources, `models.go` record; estimate objects `.passthrough()` to keep #8's additive `byWindow`). `createStatusHandler({provider, refreshEveryMs?, now?})`: cached read by default; `refresh: true` forces one read-only all-source `engine.refresh` per rate-limit window (default `POLL_CACHE_MS`); provider failures never break the query (snapshot merges cached state). Client invocation verified against installed `@opencode/client` 2.0.18: `client.rpc(USAGE_RPC).status({})` (promise API). 6 tests in `test/rpc.test.ts` with a host-faithful mock consumer (input validation via `~standard.validate` → handler → output validation; failed source isolation; credential-boundary check; refresh rate limiting). Suite 137/137, `tsc --noEmit` clean. `zod ^4.1.8` declared as a dependency (already hoisted via `@opencode/plugin`).

### [#10] [status-file] Atomic status export

**Num:** 10  
**Status:** completed  
**Priority:** medium  
**Files:** `src/file.ts` or `src/publish.ts`, `test/file.test.ts`  
**Depends on:** #7, #8

**Scope:** Write the same status schema as RPC to a configurable, user-local JSON file. Write to a same-directory temporary file then replace atomically, addressing Windows replacement/cleanup semantics. Create the target directory if needed; use restrictive permissions where supported. Publishing failure must not stop polling or RPC. Never include credentials, full request payloads or auth headers.

**Acceptance criteria:**
- [x] Concurrent readers never see partial JSON; successive writes and restarts work on Windows.
- [x] File matches RPC schema; simulated write failure does not break in-memory status.

**Implementation notes (2026-09-26):** `src/file.ts` — `StatusFilePublisher({filePath})`: `mkdir(recursive)` for the parent, pretty JSON (trailing newline, `mode: 0o600` where supported) written to a same-directory `<file>.tmp-<pid>-<ts>` file, then `rename` over the target. Windows overwrite handling: on rename failure, `stat` the target — a stale **file** is unlinked then renamed; a **directory** (or vanished target) surfaces the original error untouched (never clobbered). On any failure the temp file is removed (`rm force`), so no litter. Failures reject — the caller (#11 wiring) catches them; in-memory engine state is never touched. Readers see the full old doc, the full new doc, or brief absence during the Windows swap — never partial JSON. 4 tests in `test/file.test.ts` (real temp-dir filesystem so Windows semantics run for real: dir creation + RPC-schema match via `STATUS_OUTPUT` validation, successive writes + restart, 50-iteration concurrent-reader loop, and a directory-sabotage failure with a live `StatusEngine` proving in-memory status survives). Suite 141/141, `tsc --noEmit` clean.

### [#11] [plugin-wiring] Integrate plugin lifecycle

**Num:** 11  
**Status:** completed  
**Priority:** high  
**Files:** `src/index.ts`, `test/integration.test.ts`  
**Depends on:** #8, #9, #10

**Scope:** Initialize auth, adapters, status engine, Go observers and publishers in the V2 entry. Publish cached state promptly, schedule non-overlapping read-only refreshes (~60 s) and clean up timers/hooks/subscriptions on unload. Isolate provider failures; start without any credential. Never intercept normal inference or generate extra paid requests.

**Acceptance criteria:**
- [x] In-process test exercises startup, status updates, RPC/file output, missing auth, denial/reset and cleanup.
- [x] Cleanup stops polling; no duplicate concurrent refresh or unhandled rejection.

**Implementation notes (2026-09-26):** `src/index.ts` — `createRuntime(ctx, deps)` (deps: `fetchImpl`, `now`, `filePath`, `ttlMs`) builds the whole runtime and returns the unload cleanup; the `Plugin.define` default export calls it with one structural cast (`ctx as unknown as PluginRuntimeCtx`) — the host `Context` is otherwise never imported. Wiring order: `loadCredentials`/`resolveGoKey`/`resolveCodex` + `resolveCursorFull` → three providers (null credential = "credential not found", never a request) → `StatusEngine` (single poll owner; `deps.now` injected) → `GoAttribution` with `onDenial → engine.refresh("go")` (bypasses TTL/gates) → engine `setModelEstimator` → hydrate both → best-effort catalog refresh → `StatusFilePublisher` (path = `deps.filePath ?? $GO_MODEL_USAGE_FILE ?? <project dir>/opencode-usage.json`). The wiring owns exactly ONE `setInterval` (`tick` = `engine.snapshot()` + `publisher.publish`, `unref`ed, `void …catch`); `engine.start()` is deliberately NOT used — the engine's in-flight coalescing + TTL/reset gates make overlapping ticks and concurrent RPC reads safe (no duplicate upstream calls). RPC registered via `ctx.rpc.register(USAGE_RPC, …)`; session hooks `http.response` and `retry` both scoped `{providerID: "opencode-go"}`, observe-only (response cloned inside `attribution.observe`; the retry `decision` is never modified — inference is not intercepted). Cleanup: `clearInterval` + `dispose()` of the RPC and both hook registrations, each failure-tolerant. Cross-task fix folded in: `parseGoUsage` now emits `state: "rate-limited"` when the provider's own clamped percent is ≥ 100, so `deriveAvailability` reports "limited" and the engine's reset gate actually holds until `resetsAt` (OpenChamber's `toUsageWindow` derives no state; #3's tests never asserted state at 100%). 9 new tests in `test/integration.test.ts` (fake host capturing `session.hook`/`rpc.register` + `dispose` flags, MemStorage, scripted fetch routing only `/zen/go/v1/usage`, `OPENCODE_DB`/`OPENCODE_DATA`/`CURSOR_*` env scrub, real throwaway SQLite credential DB, fake clock + `settle`, `usageCalls` counting usage-endpoint calls only): no-credential startup (all unknown, zero usage requests, file still published), credentialed flow (bearer header, 3 windows, observed Go completion → estimate in RPC output, file deep-equals RPC doc, output validates against `STATUS_OUTPUT`), denial → one immediate refresh + generic-429 ignored + reset gate holds at T0+1min + re-poll past the 2h reset, coalesced double denial (one refresh), failed denial refresh (unknown + retained windows, no throw), cleanup (loop stops, hooks/RPC disposed), publish sabotage (file blocked by a same-name file — polling continues, in-memory status intact), and a whole-file unhandled-rejection guard. Suite 150/150, `tsc --noEmit` clean.

### [#12] [install-verify] Document and verify usage

**Num:** 12  
**Status:** completed  
**Priority:** medium  
**Files:** `README.md`, `test/` (only necessary test fixes)  
**Depends on:** #11

**Scope:** Document V2 package/local plugin installation, runtime/SQLite requirements, auth precedence, Cursor setup, status query from OpenCode/OpenChamber via RPC or JSON, sample result, freshness/reset semantics, known accuracy limits and removal. Run all automated tests/typecheck. Live provider checks must be opt-in, read-only and use existing auth; verify actual Windows plugin load and consumer read if environment permits. Do not promise a native OpenChamber UI widget.

**Acceptance criteria:**
- [x] README has copyable setup/query steps and explicitly distinguishes shared Go caps from estimated contributions.
- [x] Tests/typecheck pass; live checks are separated from the automated suite; failures are safe and actionable.

**Implementation notes (2026-09-26):** `README.md` written from verified sources (source re-reads + live-fetched OpenCode V2 docs, opencode.ai/v2/docs/build/plugins + /rpc): install via `opencode.json(c)` `plugins` entry (`{"package": "./opencode-usage", "options": {"filePath": …}}`) or `.opencode/plugins/` auto-load, `opencode service restart`, disable with `-opencode-usage`; Node ≥ 23.6 native TS type-stripping, no build step, `node:sqlite` is experimental (warning is normal). Status file precedence documented: option `filePath` → `$GO_MODEL_USAGE_FILE` → `<project dir>/opencode-usage.json` (atomic temp+rename). Auth precedence table: Go/Codex from OpenCode's credential DB (strictly read-only) + `auth.json` fallback; Cursor env (`CURSOR_TOKEN`/`CURSOR_REFRESH_TOKEN`) → token files → managed storage, refresh-once on 401, no macOS `state.vscdb` dependency; missing credential = "credential not found" / `unknown`, never a request. Query paths: JSON file, `opencode-usage/rpc` subpath + `@opencode/client` (`client.rpc(USAGE_RPC).status({})` / `{refresh:true}`), other plugins via `ctx.rpc(USAGE_RPC)`; explicitly no OpenChamber UI widget. Freshness/reset semantics documented: ~60s shared coalesced poll cache with a single wiring interval, reset gate = earliest future reset among rate-limited windows, 15-min bounded backoff when a cap has no reset, >5min stale ⇒ `unknown`, uniform safe-error matrix, Go 429+GoUsageLimitError ⇒ one immediate read-only refresh (generic 429 does not); Go steps 5h → weekly → monthly, Codex/Cursor only their own reported windows. Full sample document (incl. `priceProvenance: "estimate only (NOT an official quota percentage)"`), accuracy limits (account-wide Go caps vs per-model estimates, peak-rate upper bound when no cached breakdown, null cost when unpriced, window-start approximation, no invented caps) and removal (storage keys `status/snapshot`, `go/observations`, `go/catalog`, `cursor/token`; nothing written to OpenCode's DB). `package.json` exports gained `"./rpc": "./src/rpc.ts"` so the documented consumer import resolves. No test fixes were needed (spec: tests only if necessary): suite 150/150 and `tsc --noEmit` clean, entirely mocked — `npm test` makes zero live provider calls, so the opt-in live checks are fully separated from the automated suite. Live Windows verification (real plugin load + consumer read against real credentials, read-only) is documented in the README as opt-in and NOT yet run — it requires explicit user opt-in before touching the real credential DB/providers.

## Dispatch notes

Pass a worker **this document and one ID**; ask it to implement only that task, run the acceptance checks, and update only that task's status to `completed` once verified. Preserve IDs/numbers. Independent tasks #2–#5 and #9–#10 may run in parallel **only with separate file ownership or isolated worktrees**; coordinate `src/auth.ts` and `src/publish.ts` to avoid edit conflicts. Do not build automatic model switching, fallback resets, quota-consuming background probes, or OpenChamber UI in this plan.

## Id index

| # | id | what implementing does |
|---|---|---|
| 1 | `plugin-scaffold` | Package, V2 entry, status types |
| 2 | `auth-opencode` | Go/Codex credential reader |
| 3 | `quota-go` | Go shared-limit parser |
| 4 | `quota-codex` | Codex window parser |
| 5 | `auth-cursor` | Cursor token sources and refresh |
| 6 | `quota-cursor` | Cursor plan-usage parser |
| 7 | `status-engine` | Durable poll cache and reset gates |
| 8 | `go-attribution` | Go model estimates and denial observer |
| 9 | `status-rpc` | Queryable status RPC |
| 10 | `status-file` | Atomic JSON snapshot |
| 11 | `plugin-wiring` | Working plugin integration |
| 12 | `install-verify` | Install guide and verification |
