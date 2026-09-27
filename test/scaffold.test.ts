import assert from "node:assert/strict";
import { test } from "node:test";

// Type-only import: erased at runtime, so this test runs without installing @opencode/plugin.
import type { StatusSnapshot } from "../src/types.ts";
import { SCHEMA_VERSION, deriveAvailability, unknownSource } from "../src/types.ts";
import { initialSnapshot } from "../src/index.ts";

test("initial snapshot is all-unknown and schema-complete", () => {
  const snap = initialSnapshot(new Date("2026-09-26T12:00:00Z"));
  assert.equal(snap.schemaVersion, SCHEMA_VERSION);
  assert.equal(snap.updatedAt, "2026-09-26T12:00:00.000Z");
  for (const source of [snap.sources.go, snap.sources.codex, snap.sources.cursor]) {
    assert.equal(source.availability, "unknown");
    assert.equal(source.authenticated, false);
    assert.equal(source.stale, true);
    assert.deepEqual(source.windows, []);
  }
  assert.deepEqual(snap.models.go, {});
});

test("status contract separates authoritative quota from estimates and carries no credential fields", () => {
  const snap: StatusSnapshot = initialSnapshot();
  // Authoritative side: windows + availability live on sources.
  assert.ok(Array.isArray(snap.sources.go.windows));
  // Estimate side: models.go entries carry estimatedCostUSD, never a quota.
  assert.ok("go" in snap.models);
  // No credential material anywhere in the serialized document.
  const json = JSON.stringify(snap);
  for (const forbidden of ["key", "token", "authorization", "bearer"]) {
    assert.ok(!json.toLowerCase().includes(forbidden), `snapshot must not contain "${forbidden}"`);
  }
});

test("deriveAvailability: no windows => unknown, any rate-limited => limited, all ok => available", () => {
  assert.equal(deriveAvailability([]), "unknown");
  assert.equal(
    deriveAvailability([
      { name: "rolling", usedPercent: 50, state: "ok", resetsAt: null },
      { name: "weekly", usedPercent: 100, state: "rate-limited", resetsAt: "2026-09-27T00:00:00Z" },
    ]),
    "limited",
  );
  assert.equal(
    deriveAvailability([
      { name: "rolling", usedPercent: 10, state: "ok", resetsAt: null },
      { name: "monthly", usedPercent: 40, state: "ok", resetsAt: null },
    ]),
    "available",
  );
});

test("unknownSource never implies availability or exhaustion", () => {
  const s = unknownSource("go", { error: "credential not found" });
  assert.equal(s.availability, "unknown");
  assert.equal(s.checkedAt, null);
  assert.equal(s.stale, true);
  assert.equal(s.error, "credential not found");
});
