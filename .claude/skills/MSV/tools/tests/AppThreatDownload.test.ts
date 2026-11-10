/**
 * AppThreatDownload.test.ts
 *
 * Unit tests for the atomic staging-download safety logic added to
 * AppThreatClient — specifically validateDatabaseDir(), the gate that prevents
 * a truncated / corrupt / incomplete download from ever being swapped over the
 * live database. No network access.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppThreatClient } from "../AppThreatClient";

const DATA_FILE = "data.vdb6";
const INDEX_FILE = "data.index.vdb6";
const META_FILE = "vdb.meta";

/** Build a minimal but well-formed vdb directory in `dir`. */
function buildDir(
  dir: string,
  opts: { dataRows: number; indexRows: number; meta?: { data: number; index: number } | null },
): void {
  for (const [file, table, rows] of [
    [DATA_FILE, "cve_data", opts.dataRows],
    [INDEX_FILE, "cve_index", opts.indexRows],
  ] as const) {
    const db = new Database(join(dir, file), { create: true });
    db.run(`CREATE TABLE ${table} (cve_id TEXT)`);
    for (let i = 0; i < rows; i++) db.run(`INSERT INTO ${table} (cve_id) VALUES (?)`, [`CVE-${i}`]);
    db.close();
  }
  if (opts.meta !== null) {
    const m = opts.meta ?? { data: opts.dataRows, index: opts.indexRows };
    writeFileSync(
      join(dir, META_FILE),
      JSON.stringify({ cve_data_count: m.data, cve_index_count: m.index }),
    );
  }
}

// validateDatabaseDir is private; exercise it through a typed-any handle.
function validate(dir: string): boolean {
  const client = new AppThreatClient();
  return (client as unknown as { validateDatabaseDir(d: string, v: boolean): boolean })
    .validateDatabaseDir(dir, false);
}

describe("AppThreatClient.validateDatabaseDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vdbtest-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("accepts a complete DB whose row counts match the meta", () => {
    buildDir(dir, { dataRows: 5, indexRows: 7, meta: { data: 5, index: 7 } });
    expect(validate(dir)).toBe(true);
  });

  it("accepts a non-empty DB when no meta is present", () => {
    buildDir(dir, { dataRows: 3, indexRows: 3, meta: null });
    expect(validate(dir)).toBe(true);
  });

  it("rejects an incomplete DB (fewer rows than meta promises)", () => {
    // The real failure mode: a truncated extract that still opens but is short.
    buildDir(dir, { dataRows: 3, indexRows: 7, meta: { data: 5, index: 7 } });
    expect(validate(dir)).toBe(false);
  });

  it("rejects an empty DB (zero rows)", () => {
    buildDir(dir, { dataRows: 0, indexRows: 0, meta: null });
    expect(validate(dir)).toBe(false);
  });

  it("rejects when the index file is missing", () => {
    buildDir(dir, { dataRows: 5, indexRows: 5, meta: null });
    unlinkSync(join(dir, INDEX_FILE));
    expect(validate(dir)).toBe(false);
  });

  it("rejects a corrupt (non-SQLite) data file", () => {
    buildDir(dir, { dataRows: 5, indexRows: 5, meta: null });
    // Overwrite data.vdb6 with garbage — mimics a malformed/truncated image.
    writeFileSync(join(dir, DATA_FILE), Buffer.from("not a sqlite database at all"));
    expect(validate(dir)).toBe(false);
  });
});
