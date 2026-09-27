// Go model attribution (task #8).
//
// Observes OpenCode Go chat-completion responses (V2 "http.response" hook, scoped
// to the "opencode-go" provider) and Go-specific quota denials (V2 "retry" hook),
// then turns them into per-model ESTIMATES of contribution to the shared paid Go
// pool. Estimates only: the provider-reported windows (via the #3 usage endpoint)
// remain the authoritative percentages; nothing here is an official per-model cap.
//
// Verified shapes (2026-09-26):
// - GET https://opencode.ai/zen/go/v1/models (unauthenticated) =>
//   { object: "list", data: [{ id, object, created, owned_by }] } — IDs only, NO
//   pricing fields, so pricing comes from the published docs.
// - https://opencode.ai/v2/docs/console/go/ serves text/markdown with a table:
//   | Model | Input | Output | Cached Read | Cached Write | Monthly limit |
//   (USD per 1M tokens; free models' rows carry no usable prices).
// - SessionHttpResponse: { sessionID, agent, model: { providerID, id, variant? },
//   kind, request, response } — the response body is one-shot: clone() BEFORE
//   reading so the original stays readable by OpenCode.
// - SessionRetry.error: { type, message, status? }. Go exhaustion surfaces as
//   status 429 with "GoUsageLimitError" in type or message. A GENERIC 429 alone
//   does NOT establish pool exhaustion.
//
// Cost math: (prompt - cachedRead - cachedWrite) * input + completion * output,
// per 1M tokens, plus cached tokens at their discounted rates when the response
// carries a breakdown. Without a breakdown everything bills at peak input rate
// (peakRate=true) — a documented upper bound, not a fabrication.
// Window attribution approximates a window's start as resetsAt minus a nominal
// duration (rolling=5h, weekly=7d, monthly=30d) — an approximation, documented.

import type { GoModelEstimate, SourceStatus, StorageLike } from "./types.ts";

const GO_PROVIDER_ID = "opencode-go";
const GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const GO_DOCS_URL = "https://opencode.ai/v2/docs/console/go/";
const TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OBSERVATIONS = 1000;
const OBSERVATIONS_KEY = "go/observations";
const CATALOG_KEY = "go/catalog";
const ROLLING_MS = 5 * 3600_000;
const WEEKLY_MS = 7 * 24 * 3600_000;
const MONTHLY_MS = 30 * 24 * 3600_000; // nominal; a calendar month is 28-31 days

/** Published per-1M-token prices (USD) for one Go model, from the docs table. */
export interface GoPrice {
  inputPerMtok: number | null;
  outputPerMtok: number | null;
  cachedReadPerMtok: number | null;
  cachedWritePerMtok: number | null;
  /** Published monthly dollar limit for the model (context, not enforced here). */
  monthlyLimitUSD: number | null;
}

/** Cached catalog: published prices + live model IDs. */
export interface GoCatalog {
  models: Record<string, GoPrice>;
  modelIds: string[];
  freeModelIds: string[];
  fetchedAt: number;
  /** Date the prices were published/fetched (YYYY-MM-DD). */
  asOf: string;
}

/** One observed Go completion (bounded retention, persisted). */
export interface TokenObservation {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  costUSD: number | null;
  peakRate: boolean;
  at: number;
  responseId: string | null;
}

/** Normalized token usage extracted from a completion response body. */
export interface ExtractedUsage {
  responseId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
}

/** Minimal shape of SessionRetry.error ({ type, message, status? }). */
export interface DenialErrorLike {
  type?: string;
  message?: string;
  status?: number | null;
}

/** Normalize a display name or model ID to a canonical lowercase hyphenated ID (dots kept). */
export function normalizeModelId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Parse a money cell like "$0.15", "**$60**" or "-"; null when absent/invalid. */
function toMoney(cell: string): number | null {
  const cleaned = cell.replace(/[\$*,]/g, "").trim();
  if (cleaned === "-" || cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the published Go pricing table (markdown) into per-model prices keyed by
 * normalized model ID. Header/separator/priceless rows are skipped; an
 * unparseable table yields {}. Never throws.
 */
export function parsePriceTable(markdown: string): Record<string, GoPrice> {
  const out: Record<string, GoPrice> = {};
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length !== 6) continue;
    if (/^[-:\s]+$/.test(cells[0])) continue; // separator row
    const id = normalizeModelId(cells[0]);
    if (id === "" || id === "model") continue; // header row
    const input = toMoney(cells[1]);
    const output = toMoney(cells[2]);
    if (input === null && output === null) continue; // free/placeholder row
    out[id] = {
      inputPerMtok: input,
      outputPerMtok: output,
      cachedReadPerMtok: toMoney(cells[3]),
      cachedWritePerMtok: toMoney(cells[4]),
      monthlyLimitUSD: toMoney(cells[5]),
    };
  }
  return out;
}

function nonNegativeFinite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Extract token usage from a chat-completion response body (OpenAI-compatible:
 * { id, usage: { prompt_tokens, completion_tokens, total_tokens?,
 * prompt_tokens_details?: { cached_tokens?, cache_creation_tokens? } } }).
 * null when the body is not a usable completion — usage is never fabricated.
 * Never throws.
 */
export function extractUsage(body: string): ExtractedUsage | null {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }
  if (!root || typeof root !== "object") return null;
  const r = root as Record<string, unknown>;
  const usage = r.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const prompt = nonNegativeFinite(u.prompt_tokens);
  const completion = nonNegativeFinite(u.completion_tokens);
  if (prompt === null || completion === null) return null;
  const details = u.prompt_tokens_details;
  const d = details && typeof details === "object" ? (details as Record<string, unknown>) : null;
  const cachedRead = d ? nonNegativeFinite(d.cached_tokens) : null;
  const cachedWrite = d ? nonNegativeFinite(d.cache_creation_tokens) : null;
  const total = nonNegativeFinite(u.total_tokens) ?? prompt + completion;
  return {
    responseId: typeof r.id === "string" && r.id ? r.id : null,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    cachedReadTokens: cachedRead,
    cachedWriteTokens: cachedWrite,
  };
}

/**
 * True only for Go-specific quota denials: HTTP 429 carrying GoUsageLimitError
 * in type or message. A generic 429 (throttle, other provider) does NOT
 * establish exhaustion of the shared Go pool.
 */
export function isGoUsageDenial(error: DenialErrorLike): boolean {
  if (error.status !== 429) return false;
  return error.type === "GoUsageLimitError" || (error.message ?? "").includes("GoUsageLimitError");
}

/** A GoModelEstimate enriched with per-window attribution (additive, JSON-safe). */
export interface GoModelEstimateWithWindows extends GoModelEstimate {
  byWindow: Record<string, { observedTokens: number; estimatedCostUSD: number | null }>;
}

/** Cost inputs for one observation (cached breakdown fields null when absent). */
export interface CostInput {
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
}

/**
 * USD cost of one observation at a model's published per-1M-token prices.
 * null when the model's pricing is unknown. peakRate=true when no cache
 * breakdown was available (everything billed at peak input rate — an upper
 * bound, documented in the estimate provenance).
 */
export function estimateObservationCost(input: CostInput, price: GoPrice | undefined): { usd: number | null; peakRate: boolean } {
  const peakRate = input.cachedReadTokens === null;
  if (!price || price.inputPerMtok === null || price.outputPerMtok === null) return { usd: null, peakRate };
  const read = input.cachedReadTokens ?? 0;
  const write = input.cachedWriteTokens ?? 0;
  const base = Math.max(0, input.promptTokens - read - write);
  const usd =
    (base * price.inputPerMtok + input.completionTokens * price.outputPerMtok) / 1e6 +
    (read * (price.cachedReadPerMtok ?? price.inputPerMtok)) / 1e6 +
    (write * (price.cachedWritePerMtok ?? price.inputPerMtok)) / 1e6;
  return { usd, peakRate };
}

export interface GoAttributionOptions {
  storage?: StorageLike;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called on every Go-specific denial (wired to a read-only usage refresh in #11). */
  onDenial?: (denial: { at: number }) => void | Promise<void>;
  /** Bounded observation ring size (default 1000). */
  maxObservations?: number;
}

/**
 * Bounded, persisted per-model Go usage attribution. Never throws on I/O or
 * parse failures. Estimates only — see the module header.
 */
export class GoAttribution {
  private readonly opts: GoAttributionOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxObs: number;
  private readonly seenIds: Set<string> = new Set();
  private observations: TokenObservation[] = [];
  private lastDenial: { at: number } | null = null;
  private catalog: GoCatalog | null = null;

  constructor(opts: GoAttributionOptions = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.maxObs = opts.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
  }

  /** Restore bounded observations + denial flag + catalog from storage. Idempotent. */
  async hydrate(): Promise<void> {
    const storage = this.opts.storage;
    if (!storage) return;
    try {
      const raw = (await storage.get(OBSERVATIONS_KEY)) as
        | { observations?: unknown; lastDenial?: unknown }
        | null;
      if (raw && Array.isArray(raw.observations)) {
        this.observations = raw.observations.filter(
          (o): o is TokenObservation =>
            !!o &&
            typeof o === "object" &&
            typeof (o as TokenObservation).model === "string" &&
            typeof (o as TokenObservation).totalTokens === "number" &&
            Number.isFinite((o as TokenObservation).totalTokens) &&
            typeof (o as TokenObservation).at === "number" &&
            Number.isFinite((o as TokenObservation).at),
        );
        for (const o of this.observations) if (o.responseId) this.seenIds.add(o.responseId);
        this.prune();
      }
      if (
        raw &&
        raw.lastDenial &&
        typeof raw.lastDenial === "object" &&
        typeof (raw.lastDenial as { at?: unknown }).at === "number" &&
        Number.isFinite((raw.lastDenial as { at: number }).at)
      ) {
        this.lastDenial = { at: (raw.lastDenial as { at: number }).at };
      }
      const cat = (await storage.get(CATALOG_KEY)) as { catalog?: GoCatalog } | null;
      if (cat?.catalog && typeof cat.catalog.fetchedAt === "number" && cat.catalog.models) {
        this.catalog = cat.catalog;
      }
    } catch {
      /* start clean */
    }
  }

  /**
   * Record token usage from one "http.response" event (opencode-go only).
   * Clones the one-shot response before reading, so the original stays readable.
   * Dedupes on the provider response ID (retry/duplicate guard). Returns true
   * when an observation was recorded. Never throws.
   */
  async observe(input: { providerID: string; modelId: string; response: Response }): Promise<boolean> {
    if (input.providerID !== GO_PROVIDER_ID) return false;
    let usage: ExtractedUsage | null;
    try {
      usage = extractUsage(await input.response.clone().text());
    } catch {
      return false;
    }
    if (!usage) return false;
    if (usage.responseId && this.seenIds.has(usage.responseId)) return false;
    const { usd, peakRate } = estimateObservationCost(usage, this.catalog?.models[normalizeModelId(input.modelId)]);
    this.observations.push({
      model: input.modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cachedReadTokens: usage.cachedReadTokens,
      cachedWriteTokens: usage.cachedWriteTokens,
      costUSD: usd,
      peakRate,
      at: this.now(),
      responseId: usage.responseId,
    });
    if (usage.responseId) this.seenIds.add(usage.responseId);
    this.prune();
    await this.persist();
    return true;
  }

  /**
   * Handle a "retry" hook event. On a Go-specific denial, flags the shared paid
   * pool (until a fresh authoritative usage poll supersedes it) and fires the
   * onDenial callback. A generic 429 is ignored. Returns true when flagged.
   */
  async onDenial(error: DenialErrorLike): Promise<boolean> {
    if (!isGoUsageDenial(error)) return false;
    this.lastDenial = { at: this.now() };
    await this.persist();
    try {
      await this.opts.onDenial?.(this.lastDenial);
    } catch {
      /* the refresh trigger is best effort */
    }
    return true;
  }

  /** Drop oldest observations beyond the bound (and release their dedupe IDs). */
  private prune(): void {
    while (this.observations.length > this.maxObs) {
      const dropped = this.observations.shift();
      if (dropped?.responseId) this.seenIds.delete(dropped.responseId);
    }
  }

  /** Persist bounded observations, denial flag and catalog (best effort). */
  private async persist(): Promise<void> {
    const storage = this.opts.storage;
    if (!storage) return;
    try {
      await storage.set(OBSERVATIONS_KEY, { observations: this.observations, lastDenial: this.lastDenial });
      if (this.catalog) await storage.set(CATALOG_KEY, { catalog: this.catalog });
    } catch {
      /* persistence is best effort */
    }
  }

  /**
   * Refresh the price catalog: published docs table + live model list
   * (both unauthenticated, read-only). Keeps existing values when a fetch or
   * parse fails. Returns true when something was stored.
   */
  async refreshCatalog(): Promise<boolean> {
    const get = async (url: string, accept: string): Promise<Response | null> => {
      try {
        return await this.fetchImpl(url, { headers: { accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        return null;
      }
    };
    const [docsRes, modelsRes] = await Promise.all([
      get(GO_DOCS_URL, "text/markdown"),
      get(GO_MODELS_URL, "application/json"),
    ]);
    let models = this.catalog?.models ?? {};
    let modelIds = this.catalog?.modelIds ?? [];
    if (docsRes && docsRes.ok) {
      try {
        const parsed = parsePriceTable(await docsRes.text());
        if (Object.keys(parsed).length > 0) models = parsed;
      } catch {
        /* keep existing */
      }
    }
    if (modelsRes && modelsRes.ok) {
      try {
        const root = JSON.parse(await modelsRes.text()) as { data?: Array<{ id?: unknown }> };
        const ids = (Array.isArray(root.data) ? root.data : [])
          .map((m) => (typeof m?.id === "string" ? m.id : ""))
          .filter((s) => s.length > 0);
        if (ids.length > 0) modelIds = ids;
      } catch {
        /* keep existing */
      }
    }
    if (Object.keys(models).length === 0 && modelIds.length === 0) return false;
    this.catalog = {
      models,
      modelIds,
      freeModelIds: modelIds.filter((m) => normalizeModelId(m).endsWith("-free")),
      fetchedAt: this.now(),
      asOf: new Date(this.now()).toISOString().slice(0, 10),
    };
    await this.persist();
    return true;
  }

  /** Verified rule (docs + live list, 2026-09-26): free Go model IDs end in "-free". */
  isFreeModel(modelId: string): boolean {
    return normalizeModelId(modelId).endsWith("-free");
  }

  /**
   * True while a Go-specific denial is the most recent authoritative word on
   * the shared paid pool: no fresh, non-stale successful usage poll has
   * happened since. A fresh poll (success or failure) supersedes the flag.
   */
  denialCurrent(go: SourceStatus): boolean {
    const d = this.lastDenial;
    if (!d) return false;
    if (!go.checkedAt) return true;
    const t = Date.parse(go.checkedAt);
    if (!Number.isFinite(t)) return true;
    return go.stale || t < d.at;
  }

  /**
   * Per-model estimates for the snapshot. observedTokens/estimatedCostUSD are
   * cumulative over the bounded retention; byWindow attributes tokens/cost to
   * each Go window whose nominal span covers the observation. Free models are
   * exempt from the paid pool (effectiveAvailability "available"); paid models
   * inherit the pool's effective availability (denial flag => "limited").
   */
  estimates(go: SourceStatus): Record<string, GoModelEstimateWithWindows> {
    const byModel = new Map<string, TokenObservation[]>();
    for (const o of this.observations) {
      const list = byModel.get(o.model);
      if (list) list.push(o);
      else byModel.set(o.model, [o]);
    }
    const spans: Array<{ name: string; start: number; end: number }> = [];
    for (const w of go.windows) {
      if (!w.resetsAt) continue;
      const end = Date.parse(w.resetsAt);
      if (!Number.isFinite(end)) continue;
      const n = w.name.toLowerCase();
      const dur = n.includes("roll") ? ROLLING_MS : n.includes("week") ? WEEKLY_MS : n.includes("month") ? MONTHLY_MS : null;
      if (dur === null) continue;
      spans.push({ name: w.name, start: end - dur, end });
    }
    const priceAsOf = this.catalog?.asOf ?? null;
    const out: Record<string, GoModelEstimateWithWindows> = {};
    for (const [model, obs] of byModel) {
      const free = this.isFreeModel(model);
      const observedTokens = obs.reduce((s, o) => s + o.totalTokens, 0);
      // All-or-null: partial pricing would understate the true cost.
      const allPriced = obs.every((o) => o.costUSD !== null);
      const estimatedCostUSD = allPriced ? obs.reduce((s, o) => s + (o.costUSD ?? 0), 0) : null;
      let priceProvenance: string | null;
      if (free) {
        priceProvenance = "free Go model — not subject to paid pool limits (no price applied)";
      } else if (estimatedCostUSD !== null) {
        priceProvenance =
          `estimate only (NOT an official quota percentage): observed tokens x published Go pricing ` +
          `fetched ${priceAsOf} (opencode.ai/v2/docs/console/go); peak rate where the cache breakdown was missing`;
      } else {
        priceProvenance = null;
      }
      const byWindow: Record<string, { observedTokens: number; estimatedCostUSD: number | null }> = {};
      for (const span of spans) {
        const inSpan = obs.filter((o) => o.at >= span.start && o.at <= span.end);
        if (inSpan.length === 0) continue;
        const allP = inSpan.every((o) => o.costUSD !== null);
        byWindow[span.name] = {
          observedTokens: inSpan.reduce((s, o) => s + o.totalTokens, 0),
          estimatedCostUSD: allP ? inSpan.reduce((s, o) => s + (o.costUSD ?? 0), 0) : null,
        };
      }
      out[model] = {
        observedTokens,
        estimatedCostUSD,
        priceProvenance,
        free,
        effectiveAvailability: free ? "available" : this.denialCurrent(go) ? "limited" : go.availability,
        byWindow,
      };
    }
    return out;
  }
}
