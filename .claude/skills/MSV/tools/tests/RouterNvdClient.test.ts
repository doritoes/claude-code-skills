/**
 * RouterNvdClient.test.ts - Unit Tests for Router NVD Client
 *
 * Tests:
 * - CPE-based CVE queries
 * - Version range extraction
 * - MSV calculation
 * - Result formatting
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { describe, expect, test, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { RouterNvdClient, type RouterCveInfo, type MsvCalculation } from "../RouterNvdClient";
import { compareVersions } from "../RouterClient";

// =============================================================================
// Version Comparison Tests (from RouterClient, used in RouterNvdClient)
// =============================================================================

describe("RouterNvdClient Version Comparison", () => {
  test("compareVersions handles standard versions", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("compareVersions handles multi-part firmware versions", () => {
    expect(compareVersions("1.0.11.134", "1.0.11.148")).toBe(-1);
    expect(compareVersions("1.0.11.148", "1.0.11.134")).toBe(1);
    expect(compareVersions("1.0.11.134", "1.0.11.134")).toBe(0);
  });

  test("compareVersions handles different lengths", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBe(1);
    expect(compareVersions("1", "1.0.0.0")).toBe(0);
  });
});

// =============================================================================
// MSV Calculation Tests
// =============================================================================

describe("RouterNvdClient MSV Calculation", () => {
  // Create client with a temporary cache directory
  const cacheDir = "./test-cache";
  const client = new RouterNvdClient(cacheDir, { verbose: false });

  test("calculateMsv returns null for empty CVE list", () => {
    const result = client.calculateMsv([]);
    expect(result).toBeNull();
  });

  test("calculateMsv finds highest fixed version as MSV", () => {
    const cves: RouterCveInfo[] = [
      {
        cveId: "CVE-2023-0001",
        description: "Test vulnerability 1",
        cvssScore: 7.5,
        severity: "HIGH",
        published: "2023-01-01",
        affectedVersions: [{ endExcluding: "1.0.5" }],
        fixedVersion: "1.0.5",
        isKev: false,
      },
      {
        cveId: "CVE-2023-0002",
        description: "Test vulnerability 2",
        cvssScore: 9.0,
        severity: "CRITICAL",
        published: "2023-02-01",
        affectedVersions: [{ endExcluding: "1.0.10" }],
        fixedVersion: "1.0.10",
        isKev: true,
      },
      {
        cveId: "CVE-2023-0003",
        description: "Test vulnerability 3",
        cvssScore: 6.0,
        severity: "MEDIUM",
        published: "2023-03-01",
        affectedVersions: [{ endExcluding: "1.0.7" }],
        fixedVersion: "1.0.7",
        isKev: false,
      },
    ];

    const result = client.calculateMsv(cves);

    expect(result).not.toBeNull();
    expect(result!.msv).toBe("1.0.10"); // Highest fixed version
    expect(result!.kevCves).toContain("CVE-2023-0002");
    expect(result!.kevCves.length).toBe(1);
  });

  test("calculateMsv returns unknown when no fixed versions", () => {
    const cves: RouterCveInfo[] = [
      {
        cveId: "CVE-2023-0001",
        description: "Test vulnerability without fix",
        cvssScore: 7.5,
        severity: "HIGH",
        published: "2023-01-01",
        affectedVersions: [],
        fixedVersion: null,
        isKev: false,
      },
    ];

    const result = client.calculateMsv(cves);

    expect(result).not.toBeNull();
    expect(result!.msv).toBe("unknown");
    expect(result!.confidence).toBe("low");
  });

  test("calculateMsv has high confidence with KEV CVEs and multiple fixes", () => {
    const cves: RouterCveInfo[] = [
      {
        cveId: "CVE-2023-0001",
        description: "Test 1",
        cvssScore: 9.8,
        severity: "CRITICAL",
        published: "2023-01-01",
        affectedVersions: [{ endExcluding: "2.0.0" }],
        fixedVersion: "2.0.0",
        isKev: true,
      },
      {
        cveId: "CVE-2023-0002",
        description: "Test 2",
        cvssScore: 8.0,
        severity: "HIGH",
        published: "2023-02-01",
        affectedVersions: [{ endExcluding: "1.5.0" }],
        fixedVersion: "1.5.0",
        isKev: false,
      },
      {
        cveId: "CVE-2023-0003",
        description: "Test 3",
        cvssScore: 7.5,
        severity: "HIGH",
        published: "2023-03-01",
        affectedVersions: [{ endExcluding: "1.8.0" }],
        fixedVersion: "1.8.0",
        isKev: false,
      },
    ];

    const result = client.calculateMsv(cves);

    expect(result).not.toBeNull();
    expect(result!.msv).toBe("2.0.0");
    expect(result!.confidence).toBe("high");
  });

  test("calculateMsv has low confidence with single fix", () => {
    const cves: RouterCveInfo[] = [
      {
        cveId: "CVE-2023-0001",
        description: "Single vulnerability",
        cvssScore: 5.0,
        severity: "MEDIUM",
        published: "2023-01-01",
        affectedVersions: [{ endExcluding: "1.0.1" }],
        fixedVersion: "1.0.1",
        isKev: false,
      },
    ];

    const result = client.calculateMsv(cves);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("low");
  });

  test("calculateMsv ignores versions with > prefix", () => {
    const cves: RouterCveInfo[] = [
      {
        cveId: "CVE-2023-0001",
        description: "Test 1",
        cvssScore: 7.0,
        severity: "HIGH",
        published: "2023-01-01",
        affectedVersions: [{ endIncluding: "1.0.5" }],
        fixedVersion: ">1.0.5", // This is a "greater than" indicator
        isKev: false,
      },
      {
        cveId: "CVE-2023-0002",
        description: "Test 2",
        cvssScore: 8.0,
        severity: "HIGH",
        published: "2023-02-01",
        affectedVersions: [{ endExcluding: "1.0.10" }],
        fixedVersion: "1.0.10",
        isKev: false,
      },
    ];

    const result = client.calculateMsv(cves);

    expect(result).not.toBeNull();
    expect(result!.msv).toBe("1.0.10"); // Should use the explicit version
  });
});

// =============================================================================
// Result Formatting Tests
// =============================================================================

describe("RouterNvdClient Formatting", () => {
  const cacheDir = "./test-cache";
  const client = new RouterNvdClient(cacheDir, { verbose: false });

  test("formatResult handles error results", () => {
    const result = {
      model: "test_model",
      cpePrefix: "cpe:2.3:h:test:model:",
      cveCount: 0,
      kevCount: 0,
      calculation: null,
      error: "Test error message",
    };

    const output = client.formatResult(result);

    expect(output).toContain("test_model");
    expect(output).toContain("Error: Test error message");
  });

  test("formatResult shows MSV calculation", () => {
    const calculation: MsvCalculation = {
      msv: "1.5.0",
      msvDate: "2023-06-01",
      msvCves: ["CVE-2023-0001", "CVE-2023-0002"],
      kevCves: ["CVE-2023-0001"],
      allCves: [],
      confidence: "high",
    };

    const result = {
      model: "test_model",
      cpePrefix: "cpe:2.3:h:test:model:",
      cveCount: 5,
      kevCount: 1,
      calculation,
    };

    const output = client.formatResult(result);

    expect(output).toContain("test_model");
    expect(output).toContain("CVEs Found: 5");
    expect(output).toContain("KEV CVEs: 1");
    expect(output).toContain("Minimum Safe Version: 1.5.0");
    expect(output).toContain("Confidence: HIGH");
  });

  test("formatResult shows CVE details", () => {
    const calculation: MsvCalculation = {
      msv: "2.0.0",
      msvDate: "2023-06-01",
      msvCves: ["CVE-2023-0001"],
      kevCves: ["CVE-2023-0001"],
      allCves: [
        {
          cveId: "CVE-2023-0001",
          description: "Critical vulnerability",
          cvssScore: 9.8,
          severity: "CRITICAL",
          published: "2023-01-01",
          affectedVersions: [],
          fixedVersion: "2.0.0",
          isKev: true,
        },
      ],
      confidence: "high",
    };

    const result = {
      model: "test_model",
      cpePrefix: "cpe:2.3:h:test:model:",
      cveCount: 1,
      kevCount: 1,
      calculation,
    };

    const output = client.formatResult(result);

    expect(output).toContain("CVE-2023-0001");
    expect(output).toContain("[KEV]");
    expect(output).toContain("CRITICAL");
  });

  test("formatResult handles no MSV calculation", () => {
    const result = {
      model: "test_model",
      cpePrefix: "cpe:2.3:h:test:model:",
      cveCount: 0,
      kevCount: 0,
      calculation: null,
    };

    const output = client.formatResult(result);

    expect(output).toContain("No MSV calculation available");
  });
});

// =============================================================================
// Query Result Type Tests
// =============================================================================

describe("RouterNvdClient Query Result Types", () => {
  test("RouterCveInfo structure is valid", () => {
    const cve: RouterCveInfo = {
      cveId: "CVE-2023-12345",
      description: "Test vulnerability description",
      cvssScore: 7.5,
      severity: "HIGH",
      published: "2023-01-15T00:00:00Z",
      affectedVersions: [
        { startIncluding: "1.0.0", endExcluding: "1.5.0" },
        { endIncluding: "2.0.0" },
      ],
      fixedVersion: "1.5.0",
      isKev: false,
    };

    expect(cve.cveId).toMatch(/^CVE-\d{4}-\d+$/);
    expect(cve.cvssScore).toBeGreaterThanOrEqual(0);
    expect(cve.cvssScore).toBeLessThanOrEqual(10);
    expect(cve.affectedVersions.length).toBe(2);
  });

  test("MsvCalculation structure is valid", () => {
    const calc: MsvCalculation = {
      msv: "1.5.0",
      msvDate: "2023-06-01",
      msvCves: ["CVE-2023-0001", "CVE-2023-0002"],
      kevCves: ["CVE-2023-0001"],
      allCves: [],
      confidence: "medium",
      note: "Optional note",
    };

    expect(calc.msv).toBeDefined();
    expect(["high", "medium", "low"]).toContain(calc.confidence);
    expect(calc.msvCves.length).toBeGreaterThan(0);
  });
});
