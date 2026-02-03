#!/usr/bin/env bun
/**
 * Apply manual version updates to SoftwareCatalog.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const toolsDir = dirname(import.meta.path);
const catalogPath = resolve(toolsDir, "../data/SoftwareCatalog.json");
const manualPath = resolve(toolsDir, "../data/manual-version-updates.json");

const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));
const manual = JSON.parse(readFileSync(manualPath, "utf-8"));

let updateCount = 0;
let eolCount = 0;

for (const sw of catalog.software) {
  const update = manual[sw.id];
  if (update && !sw.latestVersion) {
    if (update.latest === "EOL") {
      sw.latestVersion = "EOL";
      sw.eol = true;
      if (update.note) sw.notes = update.note;
      eolCount++;
      console.log(`⊘ ${sw.id}: EOL`);
    } else {
      sw.latestVersion = update.latest;
      updateCount++;
      console.log(`✓ ${sw.id}: ${sw.latestVersion}`);
    }
    sw.lastChecked = new Date().toISOString().split("T")[0];
  }
}

// Update metadata
catalog._metadata.lastUpdated = new Date().toISOString().split("T")[0];

// Write back
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

console.log("");
console.log(`Applied ${updateCount} manual updates + ${eolCount} EOL markers`);
