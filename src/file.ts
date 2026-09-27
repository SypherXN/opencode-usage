// Publishes the status document as a local JSON file, atomically.
//
// Task #10 (status-file): same versioned schema as the RPC, written to a
// configurable user-local path. Writes a same-directory temp file, then
// replaces via rename. Windows rename cannot overwrite an existing file, so a
// stale target file is unlinked first — never a directory. Publish failures
// reject (callers catch them); they never corrupt the last good file and
// never touch in-memory state.

import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StatusSnapshot } from "./types.ts";

export interface StatusFileOptions {
  /** Path of the JSON status file (parent directories are created). */
  filePath: string;
}

/**
 * Atomically publishes the status document as pretty JSON.
 * Readers see either the full previous document or the full new one; during
 * the Windows unlink/rename swap the file may briefly be absent, never partial.
 */
export class StatusFilePublisher {
  readonly filePath: string;

  constructor(opts: StatusFileOptions) {
    this.filePath = opts.filePath;
  }

  async publish(doc: StatusSnapshot): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      // mode is only meaningful where supported (Unix); ignored on Windows.
      await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
      await this.replace(tmp);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  private async replace(tmp: string): Promise<void> {
    try {
      await rename(tmp, this.filePath);
      return;
    } catch (err) {
      // Windows: rename cannot overwrite an existing file (EPERM/EEXIST).
      const st = await stat(this.filePath).catch(() => null);
      if (!st || st.isDirectory()) throw err; // vanished target or a directory: surface as-is
      await rm(this.filePath); // stale file: unlink, then rename
      await rename(tmp, this.filePath);
    }
  }
}
