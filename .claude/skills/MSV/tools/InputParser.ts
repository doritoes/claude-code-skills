/**
 * InputParser.ts - Parse software inventory from various input formats
 *
 * Supported formats:
 * - CSV: software,version (header optional)
 * - JSON: Array of {software, version} or {name, version}
 * - Direct list: "Chrome 120.0.1, Edge, Wireshark 4.2.0"
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync } from "node:fs";

// =============================================================================
// Types
// =============================================================================

export interface SoftwareInput {
  software: string;
  currentVersion?: string;
  rawInput: string;
}

export interface ParseResult {
  items: SoftwareInput[];
  format: "csv" | "json" | "list" | "unknown";
  errors: string[];
}

// =============================================================================
// CSV Parser
// =============================================================================

export function parseCSV(content: string): ParseResult {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  const items: SoftwareInput[] = [];
  const errors: string[] = [];

  if (lines.length === 0) {
    return { items: [], format: "csv", errors: ["Empty CSV file"] };
  }

  // Detect if first line is a header
  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes("software") ||
                    firstLine.includes("name") ||
                    firstLine.includes("product") ||
                    firstLine.includes("application");

  const startIndex = hasHeader ? 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    // Parse CSV line (handle quoted values)
    const parts = parseCSVLine(line);

    if (parts.length === 0) continue;

    const software = parts[0]?.trim();
    const version = parts[1]?.trim() || undefined;

    if (!software) {
      errors.push(`Line ${i + 1}: Empty software name`);
      continue;
    }

    items.push({
      software,
      currentVersion: version && version !== "" ? version : undefined,
      rawInput: line,
    });
  }

  return { items, format: "csv", errors };
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

// =============================================================================
// JSON Parser
// =============================================================================

export function parseJSON(content: string): ParseResult {
  const items: SoftwareInput[] = [];
  const errors: string[] = [];

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return { items: [], format: "json", errors: [`Invalid JSON: ${(e as Error).message}`] };
  }

  // Handle array format
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const item = data[i];

      if (typeof item === "string") {
        // Simple string array: ["Chrome", "Edge"]
        const parsed = parseListItem(item);
        items.push(parsed);
      } else if (typeof item === "object" && item !== null) {
        // Object array: [{software: "Chrome", version: "120.0.1"}]
        const obj = item as Record<string, unknown>;
        const software = (obj.software || obj.name || obj.product || obj.application) as string;
        const version = (obj.version || obj.currentVersion || obj.installed_version) as string | undefined;

        if (!software) {
          errors.push(`Item ${i}: Missing software name`);
          continue;
        }

        items.push({
          software: String(software),
          currentVersion: version ? String(version) : undefined,
          rawInput: JSON.stringify(item),
        });
      }
    }
  }
  // Handle object with "software" or "inventory" key
  else if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const inventory = (obj.software || obj.inventory || obj.applications || obj.items) as unknown[];

    if (Array.isArray(inventory)) {
      return parseJSON(JSON.stringify(inventory));
    } else {
      errors.push("JSON must be an array or contain a 'software'/'inventory' array");
    }
  } else {
    errors.push("JSON must be an array of software items");
  }

  return { items, format: "json", errors };
}

// =============================================================================
// Direct List Parser
// =============================================================================

export function parseDirectList(input: string): ParseResult {
  const items: SoftwareInput[] = [];
  const errors: string[] = [];

  // Split by comma, semicolon, or newline
  const parts = input.split(/[,;\n]+/).map(p => p.trim()).filter(p => p);

  for (const part of parts) {
    if (!part) continue;
    items.push(parseListItem(part));
  }

  return { items, format: "list", errors };
}

/**
 * Parse a single list item like "Chrome 120.0.1" or "Microsoft Edge"
 */
function parseListItem(input: string): SoftwareInput {
  const trimmed = input.trim();

  // Try to extract version from end of string
  // Patterns: "Chrome 120.0.1", "Edge v121.0.2", "Wireshark (4.2.0)"

  // Pattern 1: Version at end after space (most common)
  // "Chrome 120.0.6099.130" -> software: "Chrome", version: "120.0.6099.130"
  const versionAtEnd = trimmed.match(/^(.+?)\s+v?(\d+(?:\.\d+)+)$/i);
  if (versionAtEnd) {
    return {
      software: versionAtEnd[1].trim(),
      currentVersion: versionAtEnd[2],
      rawInput: trimmed,
    };
  }

  // Pattern 2: Version in parentheses
  // "Wireshark (4.2.0)" -> software: "Wireshark", version: "4.2.0"
  const versionInParens = trimmed.match(/^(.+?)\s*\(v?(\d+(?:\.\d+)+)\)$/i);
  if (versionInParens) {
    return {
      software: versionInParens[1].trim(),
      currentVersion: versionInParens[2],
      rawInput: trimmed,
    };
  }

  // No version found
  return {
    software: trimmed,
    currentVersion: undefined,
    rawInput: trimmed,
  };
}

// =============================================================================
// Auto-detect Format
// =============================================================================

export function parseInput(input: string, format?: "csv" | "json" | "list"): ParseResult {
  // If format is specified, use it
  if (format === "csv") return parseCSV(input);
  if (format === "json") return parseJSON(input);
  if (format === "list") return parseDirectList(input);

  // Auto-detect format
  const trimmed = input.trim();

  // Check if it looks like JSON
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return parseJSON(trimmed);
    } catch {
      // Not valid JSON, try other formats
    }
  }

  // Check if it looks like CSV (has commas and multiple lines or structured format)
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > 1) {
    const firstLine = lines[0].toLowerCase();
    // Check for CSV header or consistent comma-separated structure
    if (firstLine.includes(",") &&
        (firstLine.includes("software") ||
         firstLine.includes("name") ||
         firstLine.includes("version") ||
         lines.every(l => l.includes(",") || l.trim() === ""))) {
      return parseCSV(trimmed);
    }
  }

  // Default to direct list
  return parseDirectList(trimmed);
}

// =============================================================================
// File Reader
// =============================================================================

export function parseFile(filePath: string): ParseResult {
  if (!existsSync(filePath)) {
    return {
      items: [],
      format: "unknown",
      errors: [`File not found: ${filePath}`],
    };
  }

  const content = readFileSync(filePath, "utf-8");
  const ext = filePath.toLowerCase().split(".").pop();

  switch (ext) {
    case "csv":
      return parseCSV(content);
    case "json":
      return parseJSON(content);
    case "txt":
      return parseInput(content); // Auto-detect
    default:
      return parseInput(content); // Auto-detect
  }
}
