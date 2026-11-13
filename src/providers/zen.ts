// Undocumented Console billing endpoint, also used by OpenChamber. Read-only.
import type { SourceStatus } from "../types.ts";
import { deriveAvailability, unknownSource } from "../types.ts";

export function parseZenBalance(payload: unknown): number | null {
  const raw = (payload as { availableMicroCents?: unknown } | null)?.availableMicroCents;
  if (typeof raw !== "number" && (typeof raw !== "string" || !/^\d+(?:\.\d+)?$/.test(raw))) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value / 100_000_000 : null;
}

export function zenProvider(opts: {
  resolveCredential: () => { access: string; orgID: string } | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): { id: "zen"; fetch(): Promise<SourceStatus> } {
  return {
    id: "zen",
    async fetch() {
      const credential = opts.resolveCredential();
      if (!credential) return unknownSource("zen", { error: "Console OAuth sign-in required for Zen credits" });
      const failed = (error: string) => unknownSource("zen", { authenticated: true, error });
      let response: Response;
      try {
        response = await (opts.fetchImpl ?? fetch)("https://opencode.ai/console/api/billing/status", {
          headers: { Accept: "application/json", Authorization: `Bearer ${credential.access}`, "x-org-id": credential.orgID,
            "User-Agent": "opencode-usage" },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      } catch { return failed("billing request failed or timed out"); }
      if (!response.ok) return failed(response.status === 401 || response.status === 403
        ? "Console OAuth sign-in rejected" : `billing API returned HTTP ${response.status}`);
      let payload: unknown;
      try { payload = await response.json(); } catch { return failed("malformed billing JSON response"); }
      const balanceUSD = parseZenBalance(payload);
      if (balanceUSD === null) return failed("billing balance missing or invalid");
      const windows = [{ name: "credits_balance", balanceUSD, currency: "USD" as const,
        usedPercent: null, resetsAt: null, state: balanceUSD > 0 ? "ok" as const : "rate-limited" as const }];
      return { authenticated: true, checkedAt: new Date((opts.now ?? Date.now)()).toISOString(),
        stale: false, error: null, windows, availability: deriveAvailability(windows), plan: null };
    },
  };
}
