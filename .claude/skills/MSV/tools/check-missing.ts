#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const toolsDir = dirname(import.meta.path);
const catalogPath = resolve(toolsDir, "../data/SoftwareCatalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));

const missing = catalog.software.filter((s: any) => !s.latestVersion);

console.log(`=== Still Missing latestVersion (${missing.length}) ===`);
console.log("");

// Group by priority
const critical = missing.filter((s: any) => s.priority === "critical");
const high = missing.filter((s: any) => s.priority === "high");
const medium = missing.filter((s: any) => s.priority === "medium");
const other = missing.filter((s: any) => !s.priority || s.priority === "low");

console.log(`CRITICAL (${critical.length}):`);
critical.forEach((s: any) => console.log(`  - ${s.id}: ${s.displayName}`));

console.log("");
console.log(`HIGH (${high.length}):`);
high.forEach((s: any) => console.log(`  - ${s.id}: ${s.displayName}`));

console.log("");
console.log(`MEDIUM/LOW/NONE (${medium.length + other.length})`);
