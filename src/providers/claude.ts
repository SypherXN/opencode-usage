// Claude subscription usage provider (mirrors OpenChamber's claude quota provider).
//
// GET https://api.anthropic.com/api/oauth/usage with Claude Code's OAuth token.
// Read-only; does not consume quota. The endpoint is undocumented and may change.
// Payload: { five_hour: {utilization (percent), resets_at (ISO)}, seven_day, seven_day_opus,
// seven_day_sonnet } — entries may be null. Failures => unknown, never "limited".

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import type { ClaudeAuth, ClaudeTokenSource } from "../claude-auth.ts";
import type { SourceStatus, UsageWindow } from "../types.ts";
import { deriveAvailability, unknownSource } from "../types.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROBE_URL = "https://api.anthropic.com/v1/messages";
const PROBE_MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 15_000;
/** Matches OpenChamber's usage-tab cadence (3 min) so the two share the token's budget. */
export const CLAUDE_POLL_MS = 3 * 60_000;
/** Minimum gap between opt-in inference probes. Input tokens count; output is capped at 1. */
export const CLAUDE_PROBE_MS = 3 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000; // OpenChamber's default; Retry-After may extend it
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;
const FAILURE_COOLDOWN_MS = 60_000;
const FIELDS: Array<[string, string]> = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_opus", "7d_opus"],
  ["seven_day_sonnet", "7d_sonnet"],
];

export function parseClaudeUsage(payload: unknown): UsageWindow[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  for (const [field, name] of FIELDS) {
    const w = root[field] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!w || typeof w !== "object" || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    const usedPercent = Math.min(100, Math.max(0, w.utilization));
    const t = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    windows.push({
      name,
      usedPercent,
      state: usedPercent >= 100 ? "rate-limited" : "ok",
      resetsAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
    });
  }
  return windows;
}

function headerFraction(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function headerUnixSeconds(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n * 1000 <= 8.64e15 ? n : null;
}

/** Only headers, never the response body/prompt/account data. Missing or malformed fields stay null/unknown. */
export function parseClaudeProbeHeaders(headers: Headers): UsageWindow[] {
  const overage = ["allowed", "allowed_warning"].includes(
    headers.get("anthropic-ratelimit-unified-overage-status") ?? "",
  ) || headers.get("anthropic-ratelimit-unified-overage-included") === "true";
  const windows: UsageWindow[] = [];
  for (const suffix of ["5h", "7d"] as const) {
    const base = `anthropic-ratelimit-unified-${suffix}`;
    const utilization = headerFraction(headers.get(`${base}-utilization`));
    const reset = headerUnixSeconds(headers.get(`${base}-reset`));
    const rawStatus = headers.get(`${base}-status`);
    const status = rawStatus === "allowed" || rawStatus === "allowed_warning" || rawStatus === "rejected"
      ? rawStatus : null;
    if (utilization === null && reset === null && status === null) continue;
    const state = status === "rejected"
      ? (overage ? "unknown" : "rate-limited")
      : status === "allowed" || status === "allowed_warning" ? "ok" : "unknown";
    windows.push({
      name: suffix,
      usedPercent: utilization === null ? null : utilization * 100,
      state,
      resetsAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    });
  }
  return windows;
}

export interface ClaudeProviderOptions {
  /** Re-reads the token on each fetch (Claude Code rotates it). Source is reported in errors. */
  resolveAuth?: () => ClaudeAuth | null;
  /** Ordered credential candidates, highest precedence first. Defaults to [resolveAuth()]. */
  resolveAuths?: () => ClaudeAuth[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Shared gate file so restarts and parallel sessions respect one cooldown/poll cadence. Holds no secrets. */
  stateFile?: string;
  /**
   * Opt-in inference probe: at most one output token per 3 minutes against
   * /v1/messages using the env setup-token. Input tokens also count, so this
   * consumes a small amount of plan quota; failed requests may consume none.
   */
  probe?: boolean;
  /** Probe gate file. Must be distinct from the read-only usage gate. Holds no secrets. */
  probeStateFile?: string;
}

/** Cross-process reservation for the probe. Stale after a request timeout. */
const PROBE_LOCK_STALE_MS = TIMEOUT_MS + 5_000;

function acquireProbeLock(file: string): (() => void) | null {
  try {
    const fd = openSync(file, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return () => {
      try {
        unlinkSync(file);
      } catch {
        /* already gone */
      }
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
    try {
      if (Date.now() - statSync(file).mtimeMs > PROBE_LOCK_STALE_MS) {
        unlinkSync(file);
        return acquireProbeLock(file);
      }
    } catch {
      /* raced with the owner */
    }
    return null;
  }
}

interface SharedState {
  nextAllowedAt: number;
  /** Why polling is paused: the normal poll cadence, or a failure/rate-limit cooldown. */
  reason?: "cadence" | "cooldown";
  status?: SourceStatus;
  /** A credential this endpoint rejects or throttles so hard it is skipped until then. */
  blocked?: Partial<Record<ClaudeTokenSource, number>>;
}

function loadState(file?: string): SharedState | null {
  if (!file) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as SharedState;
    return typeof s?.nextAllowedAt === "number" ? s : null;
  } catch {
    return null;
  }
}

function saveState(file: string | undefined, s: SharedState): void {
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(s));
  } catch {
    /* best effort */
  }
}

export function claudeProvider(opts: ClaudeProviderOptions): { id: "claude-agent"; fetch(): Promise<SourceStatus> } {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const candidates = (): ClaudeAuth[] => {
    if (opts.resolveAuths) return opts.resolveAuths();
    const one = opts.resolveAuth?.();
    return one ? [one] : [];
  };
  // The endpoint is shared with OpenChamber (same token). After a failure, stay off
  // it: the engine's 15s unhealthy retry would otherwise hammer a limited endpoint.
  let cooldownUntil = 0;

  // Opt-in inference probe state. Kept per instance; the file gate additionally
  // covers restarts and parallel processes.
  let probeNextAt = 0;
  let probeReason: "cadence" | "cooldown" | undefined;
  let probeStatus: SourceStatus | null = null;
  let probing = false;

  const probeWait = (state: SharedState | null): SourceStatus => {
    const gate = Math.max(probeNextAt, state?.nextAllowedAt ?? 0);
    const mins = Math.max(1, Math.round((gate - now()) / 60_000));
    const reason = state?.reason ?? probeReason;
    const cached = (state?.status ?? probeStatus) as SourceStatus | undefined;
    if (cached && cached.windows.length > 0) {
      return reason === "cooldown"
        ? { ...cached, stale: true, error: `Claude probe paused after a failed request, retry in ${mins} min` }
        : { ...cached };
    }
    return unknownSource("claude-agent", { authenticated: true, error: `Claude probe paused, retry in ${mins} min` });
  };

  const probe = async (auth: ClaudeAuth): Promise<SourceStatus> => {
    if (probing || now() < probeNextAt) return probeWait(null);
    let release: (() => void) | null = null;
    if (opts.probeStateFile) {
      try {
        mkdirSync(path.dirname(opts.probeStateFile), { recursive: true });
      } catch {
        /* the save below is best effort too */
      }
      release = acquireProbeLock(`${opts.probeStateFile}.lock`);
      if (!release) {
        const shared = loadState(opts.probeStateFile);
        return shared && now() < shared.nextAllowedAt
          ? probeWait(shared)
          : unknownSource("claude-agent", { authenticated: true, error: "Claude probe already in progress" });
      }
    }
    probing = true;
    let state: SharedState = { nextAllowedAt: 0 };
    try {
      state = loadState(opts.probeStateFile) ?? state;
      const gate = Math.max(probeNextAt, state.nextAllowedAt ?? 0);
      if (now() < gate) {
        probeNextAt = Math.max(probeNextAt, state.nextAllowedAt ?? 0);
        probeStatus = (state.status as SourceStatus | undefined) ?? probeStatus;
        probeReason = state.reason;
        return probeWait(state);
      }
      const commit = (ms: number, reason: "cadence" | "cooldown", fresh?: SourceStatus) => {
        probeNextAt = now() + ms;
        probeReason = reason;
        if (fresh) probeStatus = fresh;
        saveState(opts.probeStateFile, {
          nextAllowedAt: probeNextAt,
          reason,
          status: (probeStatus ?? state.status) as SourceStatus | undefined,
        });
      };
      // Reserve and persist the full cadence while still holding the lock, before
      // the request. A crash after this point cannot permit another probe inside
      // the 3-minute window, even after stale-lock recovery.
      const reservedUntil = now() + CLAUDE_PROBE_MS;
      probeNextAt = reservedUntil;
      probeReason = "cadence";
      saveState(opts.probeStateFile, {
        nextAllowedAt: reservedUntil,
        reason: "cadence",
        status: (probeStatus ?? state.status) as SourceStatus | undefined,
      });
      let response: Response;
      try {
        response = await fetchImpl(PROBE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        commit(CLAUDE_PROBE_MS, "cooldown");
        return unknownSource("claude-agent", { authenticated: true, error: "probe request failed or timed out" });
      }
      void response.body?.cancel().catch(() => {}); // headers only; never read the body
      if (response.status === 401 || response.status === 403) {
        commit(CLAUDE_PROBE_MS, "cooldown");
        return unknownSource("claude-agent", { authenticated: true, error: "probe authentication failed (env token rejected)" });
      }
      if (response.status === 429) {
        const secs = Number(response.headers.get("retry-after"));
        const asked = Number.isFinite(secs) && secs > 0 ? secs * 1000 : RATE_LIMIT_COOLDOWN_MS;
        const ms = Math.min(MAX_COOLDOWN_MS, Math.max(CLAUDE_PROBE_MS, asked));
        commit(ms, "cooldown");
        return unknownSource("claude-agent", {
          authenticated: true,
          error: `probe rate limited (HTTP 429), retry in ${Math.round(ms / 60_000)} min`,
        });
      }
      if (!response.ok) {
        commit(CLAUDE_PROBE_MS, "cooldown");
        return unknownSource("claude-agent", { authenticated: true, error: `probe returned HTTP ${response.status}` });
      }
      const windows = parseClaudeProbeHeaders(response.headers);
      if (windows.length === 0) {
        commit(CLAUDE_PROBE_MS, "cooldown");
        return unknownSource("claude-agent", { authenticated: true, error: "probe usage headers missing or unparseable" });
      }
      const ok: SourceStatus = {
        authenticated: true,
        checkedAt: new Date(now()).toISOString(),
        stale: false,
        error: null,
        windows,
        availability: deriveAvailability(windows),
        plan: null,
      };
      commit(CLAUDE_PROBE_MS, "cadence", ok);
      return ok;
    } finally {
      probing = false;
      release?.();
    }
  };

  return {
    id: "claude-agent",
    async fetch(): Promise<SourceStatus> {
      if (opts.probe) {
        // Probe mode is env-only: the setup-token is the credential this feature opted into.
        const auth = candidates().find((a) => a.source === "env");
        if (!auth) return unknownSource("claude-agent", { error: "Claude Code credential not found" });
        return probe(auth);
      }
      const all = candidates();
      if (all.length === 0) return unknownSource("claude-agent", { error: "Claude Code credential not found" });
      const shared = loadState(opts.stateFile);
      const state: SharedState = { ...(shared ?? { nextAllowedAt: 0 }) };
      const blockedUntil = (s: ClaudeTokenSource) => state.blocked?.[s] ?? 0;
      const gate = Math.max(cooldownUntil, state.nextAllowedAt ?? 0);
      if (now() < gate) {
        const mins = Math.max(1, Math.round((gate - now()) / 60_000));
        const cached = state.status as SourceStatus | undefined;
        const reusable = !!cached && cached.windows.length > 0 && cooldownUntil <= now();
        // Normal cadence wait: the cached reading is still the current answer, not an error.
        if (reusable && state.reason !== "cooldown") return { ...cached };
        const waitError = `Claude usage paused after a rate-limit response, retry in ${mins} min`;
        // Serve the last good reading, but say why it is old.
        if (reusable) return { ...cached, stale: true, error: waitError };
        return unknownSource("claude-agent", { authenticated: true, error: waitError });
      }
      const save = (next: SharedState) => {
        state.nextAllowedAt = next.nextAllowedAt;
        state.reason = next.reason;
        state.status = next.status ?? state.status;
        saveState(opts.stateFile, state);
      };
      const hold = (ms: number) => {
        cooldownUntil = now() + ms;
        save({ nextAllowedAt: cooldownUntil, reason: "cooldown", status: state.status });
      };
      const block = (source: ClaudeTokenSource, ms: number) => {
        state.blocked = { ...(state.blocked ?? {}), [source]: now() + ms };
        save({ nextAllowedAt: state.nextAllowedAt, reason: state.reason, status: state.status });
      };
      // Highest precedence first; a credential this endpoint refuses is skipped until
      // its block expires, so one bad source never strands the poller.
      const fresh = all.filter((a) => blockedUntil(a.source) <= now());
      const pool = fresh.length > 0 ? fresh : all.slice(0, 1);
      let lastError = "usage API request failed";
      for (let i = 0; i < pool.length; i++) {
        const auth = pool[i];
        const last = i === pool.length - 1;
        const via = ` (${auth.source} token)`;
        let response: Response;
        try {
          response = await fetchImpl(USAGE_URL, {
            headers: { Authorization: `Bearer ${auth.token}`, "anthropic-beta": "oauth-2025-04-20" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch {
          hold(FAILURE_COOLDOWN_MS);
          return unknownSource("claude-agent", { authenticated: true, error: "request failed or timed out" });
        }
        if (response.status === 401 || response.status === 403) {
          lastError = `authentication failed (token rejected${via})`;
          if (!last) {
            block(auth.source, RATE_LIMIT_COOLDOWN_MS);
            continue;
          }
          hold(FAILURE_COOLDOWN_MS);
          return unknownSource("claude-agent", { authenticated: true, error: lastError });
        }
        if (response.status === 429) {
          const secs = Number(response.headers.get("retry-after"));
          const wait = Number.isFinite(secs) && secs > 0 ? secs * 1000 : RATE_LIMIT_COOLDOWN_MS;
          // Honour the full back-off: retrying before the server's own deadline renews
          // the penalty and can loop for days.
          const ms = Math.min(MAX_COOLDOWN_MS, Math.max(RATE_LIMIT_COOLDOWN_MS, wait));
          const asked = Number.isFinite(secs) && secs > 0 ? `${secs}s` : "no Retry-After";
          lastError = `usage API rate limited (HTTP 429, ${asked})${via}`;
          if (!last) {
            // A per-credential throttle: try the next source instead of pausing everything.
            block(auth.source, ms);
            continue;
          }
          hold(ms);
          return unknownSource("claude-agent", {
            authenticated: true,
            error: `${lastError}, retry in ${Math.round(ms / 60_000)} min`,
          });
        }
        if (!response.ok) {
          hold(FAILURE_COOLDOWN_MS);
          return unknownSource("claude-agent", { authenticated: true, error: `usage API returned HTTP ${response.status}` });
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          lastError = "malformed JSON response";
          continue;
        }
        const windows = parseClaudeUsage(payload);
        if (windows.length === 0) {
          lastError = "usage data could not be parsed";
          continue;
        }
        const ok: SourceStatus = {
          authenticated: true,
          checkedAt: new Date(now()).toISOString(),
          stale: false,
          error: null,
          windows,
          availability: deriveAvailability(windows),
          plan: null,
        };
        // Success: hold other pollers off for one cadence and share the result with them.
        save({ nextAllowedAt: now() + CLAUDE_POLL_MS - 5_000, reason: "cadence", status: ok });
        return ok;
      }
      return unknownSource("claude-agent", { authenticated: true, error: lastError });
    },
  };
}
