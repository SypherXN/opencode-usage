// OpenCode V2 plugin entry for OpenCode Usage (task #11 plugin-wiring).
//
// Wires the whole plugin into one V2 lifecycle:
//   credentials (#2/#5) -> providers (#3/#4/#6) -> status engine (#7)
//   -> Go attribution (#8) -> RPC (#9) + status file (#10) -> one poll loop.
//
// Rules:
// - The engine is the SINGLE owner of upstream polling (TTL, reset gates,
//   in-flight coalescing). The wiring adds exactly one background interval:
//   tick = engine.snapshot() + file publish. engine.start() is NOT used, so an
//   upstream endpoint is never polled twice concurrently.
// - Failure isolation: provider errors degrade to "unknown", publish errors
//   are swallowed, hooks are observe-only and never modify inference.
// - Starts fine without any credential (all sources "unknown", no requests).
// - Cleanup on unload stops the interval and disposes RPC/hook registrations.

import path from "node:path";
import { Plugin } from "@opencode/plugin";
import { GoAttribution, type DenialErrorLike } from "./attribution.ts";
import { loadCredentials, resolveCodex, resolveGoKey } from "./auth.ts";
import { resolveCursorFull, saveManagedToken } from "./cursor-auth.ts";
import { StatusFilePublisher } from "./file.ts";
import { codexProvider } from "./providers/codex.ts";
import { goProvider } from "./providers/go.ts";
import { cursorProvider } from "./providers/cursor.ts";
import { createStatusHandler, USAGE_RPC } from "./rpc.ts";
import { StatusEngine } from "./status.ts";
import {
  POLL_CACHE_MS,
  SCHEMA_VERSION,
  type StatusSnapshot,
  type StorageLike,
} from "./types.ts";

/** Structural shapes of the two host session events we observe (never modified). */
interface HttpResponseEvent {
  model?: { providerID?: string; id?: string; variant?: string };
  response?: Response;
}

interface RetryEvent {
  error?: DenialErrorLike;
}

interface RegistrationLike {
  dispose: () => Promise<void>;
}

/**
 * Minimal structural host context the wiring needs. The real V2 `Context`
 * satisfies it; the single `as unknown as` cast at the Plugin.define boundary
 * below is the only place the two shapes meet.
 */
export interface PluginRuntimeCtx {
  location: { directory: string };
  options: Record<string, unknown>;
  storage: StorageLike;
  rpc: {
    register(definition: unknown, handlers: Record<string, unknown>): Promise<RegistrationLike>;
  };
  session: {
    hook(
      name: string,
      callback: (input: unknown) => void | Promise<void>,
      options?: { providerID?: string },
    ): Promise<RegistrationLike>;
  };
}

/** Injectable wiring dependencies (tests script these; production uses defaults). */
export interface RuntimeDeps {
  /** Injectable fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Status file path. Default: $GO_MODEL_USAGE_FILE or <project dir>/opencode-usage.json. */
  filePath?: string;
  /** One-time estimated Cursor reset date (provider data takes precedence). */
  cursorResetAt?: string;
  /** Cache TTL / background interval (ms). Defaults to POLL_CACHE_MS (~60s). */
  ttlMs?: number;
}

/** Initial all-unknown snapshot — what the plugin reports before any credential is found. */
export function initialSnapshot(now: Date = new Date()): StatusSnapshot {
  const unknownSource = {
    authenticated: false,
    checkedAt: null,
    stale: true,
    error: null,
    windows: [],
    nextAvailableAt: null,
    availability: "unknown" as const,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    sources: { go: unknownSource, codex: unknownSource, cursor: unknownSource },
    models: { go: {} },
  };
}

/**
 * Build and start the plugin runtime. Returns the unload cleanup, which stops
 * the poll interval and disposes the RPC and hook registrations.
 */
export async function createRuntime(
  ctx: PluginRuntimeCtx,
  deps: RuntimeDeps = {},
): Promise<() => Promise<void>> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ttlMs = deps.ttlMs ?? POLL_CACHE_MS;
  const storage = ctx.storage;

  // Credentials (read-only; values never leave these closures).
  const found = loadCredentials();
  const goKey = resolveGoKey(found);
  const codexCred = resolveCodex(found);
  const cursorCred = await resolveCursorFull({ storage, fetchImpl, now });

  // Providers: never throw; a missing credential means "credential not found", no request.
  const providers = {
    go: goProvider({ apiKey: goKey, fetchImpl, now }),
    codex: codexProvider({
      accessToken: codexCred?.access ?? null,
      accountId: codexCred?.accountId ?? null,
      fetchImpl,
      now,
    }),
    cursor: cursorProvider({
      accessToken: cursorCred?.accessToken ?? null,
      refreshToken: cursorCred?.refreshToken ?? null,
        onRotatedToken: (access, refresh) => saveManagedToken(storage, access, refresh, cursorCred?.sourceFile),
      fetchImpl,
      now,
    }),
  };

  // Engine (single owner of polling) + Go attribution (estimates only).
  const engine = new StatusEngine({ providers, storage, now, ttlMs, cursorResetAt: deps.cursorResetAt });
  const attribution = new GoAttribution({
    storage,
    fetchImpl,
    now,
    onDenial: async () => {
      await engine.refresh("go"); // one immediate read-only usage poll (bypasses TTL/gates)
    },
  });
  engine.setModelEstimator((go) => attribution.estimates(go));
  await engine.hydrate();
  await attribution.hydrate();
  // Read-only price/model catalog refresh (unauthenticated); best effort.
  void attribution.refreshCatalog().catch(() => {});

  // Status file publisher (atomic; its failures must not stop polling or RPC).
  const filePath =
    deps.filePath ??
    process.env.GO_MODEL_USAGE_FILE ??
    path.join(ctx.location.directory, "opencode-usage.json");
  const publisher = new StatusFilePublisher({ filePath });

  // One background driver: snapshot (coalesced poll pass) + publish.
  const tick = async (): Promise<void> => {
    const doc = await engine.snapshot();
    await publisher.publish(doc);
  };

  const registrations: RegistrationLike[] = [];

  // Read-only RPC (cached reads; rate-limited manual refresh).
  const statusHandler = createStatusHandler({ provider: engine, refreshEveryMs: ttlMs, now });
  registrations.push(
    await ctx.rpc.register(USAGE_RPC, {
      status: (input: { refresh?: boolean }) => statusHandler(input),
    }),
  );

  // Session hooks: observe-only, scoped to the Go provider. They never modify
  // the request/response or the retry decision — inference is not intercepted.
  registrations.push(
    await ctx.session.hook(
      "http.response",
      (input: unknown) => {
        const ev = input as HttpResponseEvent;
        if (!ev?.response || !ev.model?.id) return;
        void attribution
          .observe({ providerID: ev.model.providerID ?? "", modelId: ev.model.id, response: ev.response })
          .catch(() => {});
      },
      { providerID: "opencode-go" },
    ),
  );
  registrations.push(
    await ctx.session.hook(
      "retry",
      (input: unknown) => {
        const ev = input as RetryEvent;
        void attribution.onDenial(ev?.error ?? {}).catch(() => {});
      },
      { providerID: "opencode-go" },
    ),
  );

  // The interval is the ONLY timer we own. Overlapping ticks can never double-
  // poll: the engine coalesces in-flight polls and gates on TTL + resets.
  void tick().catch(() => {}); // publish promptly (the first pass polls cold sources)
  const timer = setInterval(() => {
    void tick().catch(() => {});
  }, ttlMs);
  timer.unref?.();

  return async () => {
    clearInterval(timer);
    for (const reg of registrations) {
      await reg.dispose().catch(() => {});
    }
  };
}

export default Plugin.define({
    id: "opencode-usage",
  async setup(ctx) {
    const optFile = ctx.options?.filePath;
    const cursorResetAt = ctx.options?.cursorResetAt;
    return createRuntime(ctx as unknown as PluginRuntimeCtx, {
      filePath: typeof optFile === "string" && optFile.length > 0 ? optFile : undefined,
      cursorResetAt: typeof cursorResetAt === "string" ? cursorResetAt : undefined,
    });
  },
});
