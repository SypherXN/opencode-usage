// Read-only V2 RPC exposing the model usage status document.
//
// Task #9 (status-rpc): register `opencode-usage.status` with validated
// input/output. Cached reads by default; an optional manual refresh is
// rate-limited. Secrets are never accepted as input, and the output schema is
// the versioned status contract (no credential fields).
//
// Consumers (e.g. @opencode/client) call it as:
//   const usage = client.rpc(USAGE_RPC);
//   const doc = await usage.status({});            // cached read
//   const doc = await usage.status({ refresh: true }); // rate-limited refresh

import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import type { SourceId } from "./status.ts";
import { POLL_CACHE_MS, SCHEMA_VERSION, type SourceStatus, type StatusSnapshot } from "./types.ts";

/** All source ids, for a manual all-source refresh. */
export const ALL_SOURCES: SourceId[] = ["go", "codex", "cursor"];

const availability = z.enum(["available", "limited", "unknown"]);
const windowState = z.enum(["ok", "rate-limited", "unknown"]);

/** Input for `opencode-usage.status`. Strict: any other field (secrets included) is rejected. */
export const STATUS_INPUT = z
  .object({
    /** Force one immediate read-only refresh of all sources (rate-limited). */
    refresh: z.boolean().optional(),
  })
  .strict();

const windowSchema = z.object({
  name: z.string(),
  usedPercent: z.number().nullable(),
  state: windowState,
  resetsAt: z.string().nullable(),
  resetDay: z.number().int().min(1).max(31).optional(),
  resetEstimated: z.boolean().optional(),
});

const sourceSchema = z.object({
  authenticated: z.boolean(),
  checkedAt: z.string().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),
  windows: z.array(windowSchema),
  nextAvailableAt: z.string().nullable(),
  availability,
});

// ponytail: passthrough preserves additive estimate fields (e.g. #8's byWindow).
const estimateSchema = z
  .object({
    observedTokens: z.number(),
    estimatedCostUSD: z.number().nullable(),
    priceProvenance: z.string().nullable(),
    free: z.boolean(),
    effectiveAvailability: availability,
  })
  .passthrough();

/** The versioned status document as published by this RPC. */
export const STATUS_OUTPUT = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  updatedAt: z.string(),
  sources: z.object({ go: sourceSchema, codex: sourceSchema, cursor: sourceSchema }),
  models: z.object({ go: z.record(z.string(), estimateSchema) }),
});

/** Portable V2 RPC definition (zod schemas satisfy StandardSchemaV1). */
export const USAGE_RPC = Rpc.define({
  id: "opencode-usage",
  methods: {
    status: { input: STATUS_INPUT, output: STATUS_OUTPUT },
  },
  events: {},
});

/** Minimal state-manager surface the status handler needs (satisfied by StatusEngine). */
export interface StatusProvider {
  snapshot(): Promise<StatusSnapshot>;
  refresh(id: SourceId): Promise<SourceStatus>;
}

export interface StatusHandlerOptions {
  provider: StatusProvider;
  /** Minimum interval between manual refreshes. Default: POLL_CACHE_MS. */
  refreshEveryMs?: number;
  /** Clock for rate limiting. Default: Date.now. */
  now?: () => number;
}

type StatusInput = z.infer<typeof STATUS_INPUT>;
type StatusOutput = z.infer<typeof STATUS_OUTPUT>;

/**
 * Build the `status` handler. Cached reads by default; `refresh: true` forces
 * one read-only all-source refresh per rate-limit window. Provider failures
 * never break the query — the snapshot merges cached state.
 */
export function createStatusHandler(opts: StatusHandlerOptions) {
  const everyMs = opts.refreshEveryMs ?? POLL_CACHE_MS;
  const now = opts.now ?? Date.now;
  let lastRefresh = 0;
  return async (input: StatusInput): Promise<StatusOutput> => {
    if (input.refresh) {
      const t = now();
      if (t - lastRefresh >= everyMs) {
        lastRefresh = t;
        await Promise.all(ALL_SOURCES.map((id) => opts.provider.refresh(id)));
      }
    }
    return opts.provider.snapshot();
  };
}
