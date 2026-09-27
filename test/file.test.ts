// Task #10 (status-file) tests: atomic JSON publishing.
//
// Uses the real filesystem in a throwaway temp dir (no network, no
// credentials) so the Windows rename/replace semantics are exercised for
// real: successive writes, restarts, concurrent readers, and failures.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { STATUS_OUTPUT } from "../src/rpc.ts";
import { StatusFilePublisher } from "../src/file.ts";
import { StatusEngine } from "../src/status.ts";
import { SCHEMA_VERSION, type StatusSnapshotSource, type StatusSnapshot } from "../src/types.ts";

const T0 = 1_760_000_000_000;

function source(overrides: Partial<StatusSnapshotSource> = {}): StatusSnapshotSource {
  return {
    authenticated: true,
    checkedAt: new Date(T0).toISOString(),
    stale: false,
    error: null,
    windows: [{ name: "rolling", usedPercent: 20, state: "ok", resetsAt: null }],
    availability: "available",
    nextAvailableAt: null,
    ...overrides,
  };
}

function doc(tag: string): StatusSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date(T0).toISOString(),
    tag,
    sources: { go: source(), codex: source(), cursor: source() },
    models: { go: {} },
  };
}

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "gomu-file-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("StatusFilePublisher", () => {
  it("creates parent directories and writes the RPC schema as JSON", async () => {
    const file = path.join(dir, "nested", "status.json");
    const publisher = new StatusFilePublisher({ filePath: file });
    const docA = doc("a");
    await publisher.publish(docA);

    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(parsed, docA);
    const res = await STATUS_OUTPUT["~standard"].validate(parsed);
    assert.equal(res.issues, undefined, "file content must match the RPC output schema");
  });

  it("successive writes and restarts replace the file (Windows rename dance)", async () => {
    const file = path.join(dir, "successive.json");
    const first = new StatusFilePublisher({ filePath: file });
    await first.publish(doc("a"));
    await first.publish(doc("b")); // second write over an existing file
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), doc("b"));

    const restarted = new StatusFilePublisher({ filePath: file }); // new instance, same file
    await restarted.publish(doc("c"));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), doc("c"));
  });

  it("concurrent readers never see partial JSON", async () => {
    const file = path.join(dir, "concurrent.json");
    const publisher = new StatusFilePublisher({ filePath: file });
    const docA = doc("a");
    const docB = doc("b");
    await publisher.publish(docA);

    let done = false;
    const inflight = publisher.publish(docB).finally(() => {
      done = true;
    });

    for (let i = 0; i < 50 && !(done && i > 5); i++) {
      let raw: string | null = null;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        raw = null; // brief absence during the swap is acceptable
      }
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw); // must always be complete JSON
        try {
          assert.deepEqual(parsed, docA);
        } catch {
          assert.deepEqual(parsed, docB);
        }
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    await inflight;
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), docB);
  });

  it("a failed publish rejects, leaves in-memory status intact, and leaves no temp litter", async () => {
    const file = path.join(dir, "sabotage", "status.json");
    const publisher = new StatusFilePublisher({ filePath: file });
    await publisher.publish(doc("a")); // last good file exists

    // Sabotage: replace the target with a directory — rename may never clobber it.
    await rm(file);
    await mkdir(file);

    const provider = { id: "go" as const, fetch: async () => source() };
    const engine = new StatusEngine({ providers: { go: provider }, now: () => T0 });
    await engine.read("go");
    const snap = await engine.snapshot();
    assert.equal(snap.sources.go.availability, "available");

    await assert.rejects(publisher.publish(snap));

    // In-memory status survives the failed publish.
    const again = await engine.snapshot();
    assert.equal(again.sources.go.availability, "available");

    // No temp litter in the target directory.
    const entries = await readdir(path.dirname(file));
    assert.ok(entries.every((e) => !e.includes(".tmp-")), `unexpected entries: ${entries.join(", ")}`);
  });
});
