// Observe the built-in Claude Agent's step metadata, never the CLI's credentials/network.
import { deriveAvailability, type SourceStatus } from "../types.ts";

export const CLAUDE_EVENTS = ["session.step.started", "session.step.ended", "session.step.failed"];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** SDKRateLimitInfo: utilization is a fraction; resetsAt is Unix seconds. */
export function parseClaudeRateLimit(value: unknown, observedAt: number): SourceStatus | null {
  const info = record(value);
  if (!["allowed", "allowed_warning", "rejected"].includes(String(info.status))) return null;
  if (!Number.isFinite(observedAt) || observedAt < 0 || observedAt > 8.64e15) return null;
  const reset = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : NaN;
  const resetsAt = Number.isFinite(reset) && reset > 0 && reset <= 8.64e15
    ? new Date(reset).toISOString() : null;
  const usedPercent = typeof info.utilization === "number" && Number.isFinite(info.utilization) &&
    info.utilization >= 0 && info.utilization <= 1 ? info.utilization * 100 : null;
  const types = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"];
  // Rejected subscription quota need not block requests when extra usage is available.
  const overage = info.isUsingOverage === true || info.overageInUse === true ||
    info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
  const state = info.status === "rejected" ? (overage ? "unknown" : "rate-limited") : "ok";
  const windows = [{
    name: types.includes(String(info.rateLimitType)) ? String(info.rateLimitType) : "reported",
    usedPercent,
    state: state as "ok" | "rate-limited" | "unknown",
    resetsAt,
  }];
  return {
    authenticated: true, checkedAt: new Date(observedAt).toISOString(), stale: false,
    error: null, plan: null, windows, availability: deriveAvailability(windows),
  };
}

/** Correlate provider identity without reading prompts, responses, or transcripts. */
export class ClaudeAgentObserver {
  private readonly pending = new Set<string>();

  observe(value: unknown): SourceStatus | null {
    const event = record(value);
    if (!CLAUDE_EVENTS.includes(String(event.type))) return null;
    const data = record(event.data);
    if (typeof data.sessionID !== "string" || typeof data.assistantMessageID !== "string") return null;
    const key = JSON.stringify([data.sessionID, data.assistantMessageID]);
    if (event.type === "session.step.started") {
      if (record(data.model).providerID !== "claude-agent") return null;
      // ponytail: cap abandoned steps at 1024; use host lifecycle eviction if this ever fills.
      if (this.pending.size >= 1024) this.pending.delete(this.pending.values().next().value!);
      this.pending.add(key);
      return null;
    }
    if (event.type !== "session.step.ended" && event.type !== "session.step.failed") return null;
    if (!this.pending.delete(key) || typeof event.created !== "number") return null;
    // OpenCode renamed providerState to native; neither shape contains credentials.
    const native = record(data.native ?? data.providerState);
    return parseClaudeRateLimit(native.rateLimit, event.created);
  }
}
