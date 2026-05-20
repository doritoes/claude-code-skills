#!/usr/bin/env bun
/**
 * run-tests.ts — Test runner that works around a Bun 1.3.4 segfault.
 *
 * `bun test` (bulk) crashes on Windows when it enumerates certain test files
 * via relative subdirectory paths — specifically tools/tests/RouterClient.test.ts
 * (133 tests) segfaults during collection when reached as a relative subpath from
 * the skill root. The IDENTICAL file passes 133/133 when invoked via an ABSOLUTE
 * path. This is a Bun runtime bug ("indicates a bug in Bun, not your code"), not a
 * test-logic failure.
 *
 * This runner invokes each test file individually via its absolute path, which
 * dodges the segfault, then aggregates pass/fail counts. Exits non-zero if any
 * test fails or any file crashes.
 *
 * Usage:  bun run tools/run-tests.ts
 */

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".cache") continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface FileResult {
  file: string;
  pass: number;
  fail: number;
  crashed: boolean;
  durationMs: number;
}

function runFile(absPath: string): FileResult {
  const t0 = Date.now();
  // Absolute path invocation avoids the Bun 1.3.4 relative-subpath segfault.
  const res = spawnSync("bun", ["test", absPath], {
    cwd: SKILL_ROOT,
    encoding: "utf-8",
    timeout: 300_000,
    shell: false,
  });
  const durationMs = Date.now() - t0;
  const output = `${res.stdout || ""}\n${res.stderr || ""}`;

  const crashed = /Segmentation fault|panic\(main thread\)|Bun has crashed/.test(output);
  const passMatch = output.match(/(\d+)\s+pass/);
  const failMatch = output.match(/(\d+)\s+fail/);
  const pass = passMatch ? parseInt(passMatch[1], 10) : 0;
  const fail = failMatch ? parseInt(failMatch[1], 10) : 0;

  return { file: absPath, pass, fail, crashed, durationMs };
}

function relName(abs: string): string {
  return abs.slice(SKILL_ROOT.length + 1).replace(/\\/g, "/");
}

function main(): void {
  const testFiles = findTestFiles(resolve(SKILL_ROOT, "tools")).sort();
  console.log(`Running ${testFiles.length} test files (absolute-path mode)\n`);

  const results: FileResult[] = [];
  for (const f of testFiles) {
    const r = runFile(f);
    results.push(r);
    const status = r.crashed
      ? "CRASH"
      : r.fail > 0
      ? "FAIL"
      : "PASS";
    const icon = status === "PASS" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(
      `${icon} ${relName(f).padEnd(42)} ${String(r.pass).padStart(4)} pass  ${String(r.fail).padStart(2)} fail  ${status === "CRASH" ? "\x1b[31mBUN CRASH\x1b[0m  " : ""}(${(r.durationMs / 1000).toFixed(1)}s)`
    );
  }

  const totalPass = results.reduce((s, r) => s + r.pass, 0);
  const totalFail = results.reduce((s, r) => s + r.fail, 0);
  const crashed = results.filter((r) => r.crashed);

  console.log("\n" + "=".repeat(60));
  console.log(`  Files:   ${results.length}`);
  console.log(`  Passed:  ${totalPass} tests`);
  console.log(`  Failed:  ${totalFail} tests`);
  if (crashed.length > 0) {
    console.log(`  \x1b[31mCrashed: ${crashed.length} file(s) — ${crashed.map((c) => relName(c.file)).join(", ")}\x1b[0m`);
  }
  console.log("=".repeat(60));

  if (totalFail > 0 || crashed.length > 0) {
    console.log("\n\x1b[31mTEST RUN FAILED\x1b[0m");
    process.exit(1);
  }
  console.log("\n\x1b[32mALL TESTS PASSED\x1b[0m");
  process.exit(0);
}

main();
