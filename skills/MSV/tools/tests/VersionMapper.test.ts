/**
 * VersionMapper.test.ts - Unit Tests for Vendor-Specific Version Normalization
 *
 * Tests the VersionMapper class and utility functions for converting
 * vendor-specific version formats to normalized semver-like strings.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { describe, expect, test, beforeAll } from "bun:test";
import {
  VersionMapper,
  getVersionMapper,
  normalizeVersion,
  compareVersionsNormalized,
  parseJavaVersion,
  parseAdobeVersion,
  parseCiscoVersion,
  type MappedVersion,
} from "../VersionMapper";

// =============================================================================
// VersionMapper Class Tests
// =============================================================================

describe("VersionMapper", () => {
  let mapper: VersionMapper;

  beforeAll(() => {
    mapper = new VersionMapper();
  });

  // ---------------------------------------------------------------------------
  // Adobe Version Tests
  // ---------------------------------------------------------------------------

  describe("Adobe versions", () => {
    test("full year format: 2024.001.20643", () => {
      const result = mapper.map("2024.001.20643", "adobe");
      expect(result.normalized).toBe("2024.1.20643");
      expect(result.major).toBe(2024);
      expect(result.minor).toBe(1);
      expect(result.patch).toBe(20643);
      expect(result.vendor).toBe("adobe");
    });

    test("short year format: 24.001.20643", () => {
      const result = mapper.map("24.001.20643", "adobe");
      expect(result.normalized).toBe("2024.1.20643");
      expect(result.major).toBe(2024);
      expect(result.minor).toBe(1);
      expect(result.patch).toBe(20643);
    });

    test("legacy format: 11.0.23", () => {
      const result = mapper.map("11.0.23", "adobe");
      expect(result.normalized).toBe("11.0.23");
      expect(result.major).toBe(11);
      expect(result.minor).toBe(0);
      expect(result.patch).toBe(23);
    });

    test("classic track: 20.005.30636", () => {
      const result = mapper.map("20.005.30636", "adobe");
      // Short year format: 20 -> 2020
      expect(result.normalized).toBe("2020.5.30636");
      expect(result.major).toBe(2020);
    });
  });

  // ---------------------------------------------------------------------------
  // Java Version Tests
  // ---------------------------------------------------------------------------

  describe("Java versions", () => {
    test("update notation: 8u401", () => {
      const result = mapper.map("8u401", "java");
      expect(result.normalized).toBe("8.0.401");
      expect(result.major).toBe(8);
      expect(result.minor).toBe(0);
      expect(result.patch).toBe(401);
      expect(result.vendor).toBe("oracle");
      expect(result.product).toBe("java");
    });

    test("update notation uppercase: 8U401", () => {
      const result = mapper.map("8U401", "java");
      expect(result.normalized).toBe("8.0.401");
    });

    test("old format with underscore: 1.8.0_401", () => {
      const result = mapper.map("1.8.0_401", "java");
      expect(result.normalized).toBe("8.0.401");
      expect(result.major).toBe(8);
      expect(result.minor).toBe(0);
      expect(result.patch).toBe(401);
    });

    test("modern with build: 21.0.1+12", () => {
      const result = mapper.map("21.0.1+12", "java");
      expect(result.normalized).toBe("21.0.1");
      expect(result.major).toBe(21);
      expect(result.minor).toBe(0);
      expect(result.patch).toBe(1);
      expect(result.build).toBe(12);
    });

    test("modern simple: 17.0.9", () => {
      const result = mapper.map("17.0.9", "java");
      expect(result.normalized).toBe("17.0.9");
      expect(result.major).toBe(17);
    });
  });

  // ---------------------------------------------------------------------------
  // .NET Version Tests
  // ---------------------------------------------------------------------------

  describe(".NET versions", () => {
    test("preview version: 9.0.0-preview.7", () => {
      const result = mapper.map("9.0.0-preview.7", "dotnet");
      expect(result.normalized).toBe("9.0.0");
      expect(result.major).toBe(9);
      expect(result.prerelease).toBe("preview.7");
      expect(result.vendor).toBe("microsoft");
      expect(result.product).toBe("dotnet");
    });

    test("RC version: 9.0.0-rc.2", () => {
      const result = mapper.map("9.0.0-rc.2", "dotnet");
      expect(result.normalized).toBe("9.0.0");
      expect(result.prerelease).toBe("rc.2");
    });

    test("standard version: 8.0.11", () => {
      const result = mapper.map("8.0.11", "dotnet");
      expect(result.normalized).toBe("8.0.11");
      expect(result.major).toBe(8);
      expect(result.minor).toBe(0);
      expect(result.patch).toBe(11);
    });
  });

  // ---------------------------------------------------------------------------
  // Fortinet Version Tests
  // ---------------------------------------------------------------------------

  describe("Fortinet versions", () => {
    test("with build number: 7.4.4 build2662", () => {
      const result = mapper.map("7.4.4 build2662", "fortinet");
      expect(result.normalized).toBe("7.4.4");
      expect(result.major).toBe(7);
      expect(result.minor).toBe(4);
      expect(result.patch).toBe(4);
      expect(result.build).toBe(2662);
      expect(result.vendor).toBe("fortinet");
      expect(result.product).toBe("fortios");
    });

    test("standard: 6.4.15", () => {
      const result = mapper.map("6.4.15", "fortinet");
      expect(result.normalized).toBe("6.4.15");
      expect(result.major).toBe(6);
    });
  });

  // ---------------------------------------------------------------------------
  // Palo Alto Version Tests
  // ---------------------------------------------------------------------------

  describe("Palo Alto versions", () => {
    test("hotfix version: 11.1.3-h1", () => {
      const result = mapper.map("11.1.3-h1", "paloalto");
      expect(result.normalized).toBe("11.1.301");
      expect(result.major).toBe(11);
      expect(result.minor).toBe(1);
      expect(result.patch).toBe(3);
      expect(result.build).toBe(1);
      expect(result.metadata).toBe("h1");
      expect(result.vendor).toBe("paloaltonetworks");
      expect(result.product).toBe("pan-os");
    });

    test("hotfix version: 10.2.7-h3", () => {
      const result = mapper.map("10.2.7-h3", "paloalto");
      expect(result.normalized).toBe("10.2.703");
      expect(result.build).toBe(3);
    });

    test("standard: 11.1.3", () => {
      const result = mapper.map("11.1.3", "paloalto");
      expect(result.normalized).toBe("11.1.3");
      expect(result.major).toBe(11);
    });
  });

  // ---------------------------------------------------------------------------
  // Cisco Version Tests
  // ---------------------------------------------------------------------------

  describe("Cisco versions", () => {
    test("parentheses format: 9.18(4)", () => {
      const result = mapper.map("9.18(4)", "cisco");
      expect(result.normalized).toBe("9.18.4");
      expect(result.major).toBe(9);
      expect(result.minor).toBe(18);
      expect(result.patch).toBe(4);
      expect(result.vendor).toBe("cisco");
    });

    test("interim release: 7.0.6-1", () => {
      const result = mapper.map("7.0.6-1", "cisco");
      expect(result.normalized).toBe("7.0.61");
      expect(result.major).toBe(7);
      expect(result.minor).toBe(0);
      expect(result.patch).toBe(6);
      expect(result.build).toBe(1);
    });

    test("standard: 9.16.4", () => {
      const result = mapper.map("9.16.4", "cisco");
      expect(result.normalized).toBe("9.16.4");
      expect(result.major).toBe(9);
    });
  });

  // ---------------------------------------------------------------------------
  // SonicWall Version Tests
  // ---------------------------------------------------------------------------

  describe("SonicWall versions", () => {
    test("four-part: 7.0.1.732", () => {
      const result = mapper.map("7.0.1.732", "sonicwall");
      expect(result.normalized).toBe("7.0.1");
      expect(result.major).toBe(7);
      expect(result.minor).toBe(0);
      expect(result.patch).toBe(1);
      expect(result.build).toBe(732);
      expect(result.vendor).toBe("sonicwall");
      expect(result.product).toBe("sonicos");
    });

    test("standard: 6.5.4", () => {
      const result = mapper.map("6.5.4", "sonicwall");
      expect(result.normalized).toBe("6.5.4");
      expect(result.major).toBe(6);
    });
  });

  // ---------------------------------------------------------------------------
  // Chrome Version Tests
  // ---------------------------------------------------------------------------

  describe("Chrome versions", () => {
    test("four-part: 122.0.6261.94", () => {
      const result = mapper.map("122.0.6261.94", "chrome");
      expect(result.normalized).toBe("122.0.6261.94");
      expect(result.major).toBe(122);
      expect(result.minor).toBe(0);
      expect(result.patch).toBe(6261);
      expect(result.build).toBe(94);
      expect(result.vendor).toBe("google");
      expect(result.product).toBe("chrome");
    });
  });

  // ---------------------------------------------------------------------------
  // Python Version Tests
  // ---------------------------------------------------------------------------

  describe("Python versions", () => {
    test("alpha: 3.13.0a1", () => {
      const result = mapper.map("3.13.0a1", "python");
      expect(result.normalized).toBe("3.13.0");
      expect(result.major).toBe(3);
      expect(result.minor).toBe(13);
      expect(result.patch).toBe(0);
      expect(result.prerelease).toBe("a1");
      expect(result.vendor).toBe("python");
    });

    test("beta: 3.13.0b2", () => {
      const result = mapper.map("3.13.0b2", "python");
      expect(result.normalized).toBe("3.13.0");
      expect(result.prerelease).toBe("b2");
    });

    test("release candidate: 3.13.0rc1", () => {
      const result = mapper.map("3.13.0rc1", "python");
      expect(result.normalized).toBe("3.13.0");
      expect(result.prerelease).toBe("rc1");
    });

    test("standard: 3.12.1", () => {
      const result = mapper.map("3.12.1", "python");
      expect(result.normalized).toBe("3.12.1");
      expect(result.major).toBe(3);
      expect(result.minor).toBe(12);
      expect(result.patch).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Generic Parsing Tests
  // ---------------------------------------------------------------------------

  describe("Generic parsing", () => {
    test("strips leading v", () => {
      const result = mapper.map("v1.2.3");
      expect(result.normalized).toBe("1.2.3");
      expect(result.major).toBe(1);
    });

    test("handles whitespace", () => {
      const result = mapper.map("  1.2.3  ");
      expect(result.normalized).toBe("1.2.3");
    });

    test("parses prerelease with hyphen", () => {
      const result = mapper.map("1.2.3-beta.1");
      expect(result.normalized).toBe("1.2.3");
      expect(result.prerelease).toBe("beta.1");
    });

    test("parses build metadata with plus", () => {
      const result = mapper.map("1.2.3+build.456");
      expect(result.normalized).toBe("1.2.3");
      expect(result.prerelease).toBe("build.456");
    });

    test("handles two-part version", () => {
      const result = mapper.map("1.2");
      expect(result.major).toBe(1);
      expect(result.minor).toBe(2);
      expect(result.patch).toBe(0);
    });

    test("handles single number", () => {
      const result = mapper.map("5");
      expect(result.major).toBe(5);
      expect(result.minor).toBe(0);
      expect(result.patch).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-Detection Tests
  // ---------------------------------------------------------------------------

  describe("Auto-detection", () => {
    test("detects Java update notation without vendor hint", () => {
      const result = mapper.map("8u401");
      expect(result.normalized).toBe("8.0.401");
      expect(result.vendor).toBe("oracle");
    });

    test("detects Cisco parentheses without vendor hint", () => {
      const result = mapper.map("9.18(4)");
      expect(result.normalized).toBe("9.18.4");
      expect(result.vendor).toBe("cisco");
    });
  });

  // ---------------------------------------------------------------------------
  // Version Comparison Tests
  // ---------------------------------------------------------------------------

  describe("compare()", () => {
    test("compares major versions", () => {
      expect(mapper.compare("2.0.0", "1.0.0")).toBe(1);
      expect(mapper.compare("1.0.0", "2.0.0")).toBe(-1);
    });

    test("compares minor versions", () => {
      expect(mapper.compare("1.2.0", "1.1.0")).toBe(1);
      expect(mapper.compare("1.1.0", "1.2.0")).toBe(-1);
    });

    test("compares patch versions", () => {
      expect(mapper.compare("1.1.2", "1.1.1")).toBe(1);
      expect(mapper.compare("1.1.1", "1.1.2")).toBe(-1);
    });

    test("equal versions return 0", () => {
      expect(mapper.compare("1.2.3", "1.2.3")).toBe(0);
    });

    test("compares build numbers", () => {
      // Chrome versions with build numbers
      expect(mapper.compare("122.0.6261.94", "122.0.6261.90", "chrome")).toBe(1);
      expect(mapper.compare("122.0.6261.90", "122.0.6261.94", "chrome")).toBe(-1);
    });

    test("release > prerelease", () => {
      expect(mapper.compare("3.12.1", "3.12.1a1", "python")).toBe(1);
      expect(mapper.compare("3.12.1a1", "3.12.1", "python")).toBe(-1);
    });

    test("prerelease ordering", () => {
      expect(mapper.compare("3.12.1b1", "3.12.1a1", "python")).toBe(1);
      expect(mapper.compare("3.12.1rc1", "3.12.1b1", "python")).toBe(1);
    });

    test("Java version comparison", () => {
      expect(mapper.compare("8u401", "8u400", "java")).toBe(1);
      expect(mapper.compare("17.0.9", "8u401", "java")).toBe(1);
    });

    test("PAN-OS hotfix comparison", () => {
      expect(mapper.compare("11.1.3-h1", "11.1.3", "paloalto")).toBe(1);
      expect(mapper.compare("11.1.3-h2", "11.1.3-h1", "paloalto")).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Utility Method Tests
  // ---------------------------------------------------------------------------

  describe("getSupportedVendors()", () => {
    test("returns array of vendors", () => {
      const vendors = mapper.getSupportedVendors();
      expect(Array.isArray(vendors)).toBe(true);
      expect(vendors).toContain("adobe");
      expect(vendors).toContain("java");
      expect(vendors).toContain("cisco");
      expect(vendors).toContain("fortinet");
      expect(vendors).toContain("paloalto");
      expect(vendors).toContain("sonicwall");
      expect(vendors).toContain("chrome");
      expect(vendors).toContain("python");
      expect(vendors).toContain("dotnet");
    });
  });

  describe("isVendorSupported()", () => {
    test("returns true for supported vendors", () => {
      expect(mapper.isVendorSupported("java")).toBe(true);
      expect(mapper.isVendorSupported("JAVA")).toBe(true);
      expect(mapper.isVendorSupported("Java")).toBe(true);
    });

    test("returns false for unsupported vendors", () => {
      expect(mapper.isVendorSupported("unknown")).toBe(false);
      expect(mapper.isVendorSupported("")).toBe(false);
    });
  });
});

// =============================================================================
// Singleton & Utility Function Tests
// =============================================================================

describe("Utility functions", () => {
  describe("getVersionMapper()", () => {
    test("returns singleton instance", () => {
      const mapper1 = getVersionMapper();
      const mapper2 = getVersionMapper();
      expect(mapper1).toBe(mapper2);
    });

    test("returns VersionMapper instance", () => {
      const mapper = getVersionMapper();
      expect(mapper).toBeInstanceOf(VersionMapper);
    });
  });

  describe("normalizeVersion()", () => {
    test("normalizes Java version", () => {
      expect(normalizeVersion("8u401", "java")).toBe("8.0.401");
    });

    test("normalizes Adobe version", () => {
      expect(normalizeVersion("24.001.20643", "adobe")).toBe("2024.1.20643");
    });

    test("normalizes without vendor hint", () => {
      expect(normalizeVersion("9.18(4)")).toBe("9.18.4");
    });
  });

  describe("compareVersionsNormalized()", () => {
    test("compares versions", () => {
      expect(compareVersionsNormalized("2.0.0", "1.0.0")).toBe(1);
      expect(compareVersionsNormalized("1.0.0", "2.0.0")).toBe(-1);
      expect(compareVersionsNormalized("1.0.0", "1.0.0")).toBe(0);
    });

    test("compares with vendor hint", () => {
      expect(compareVersionsNormalized("8u401", "8u400", "java")).toBe(1);
    });
  });

  describe("parseJavaVersion()", () => {
    test("parses update notation", () => {
      expect(parseJavaVersion("8u401")).toBe("8.0.401");
    });

    test("parses old format", () => {
      expect(parseJavaVersion("1.8.0_401")).toBe("8.0.401");
    });

    test("parses modern format", () => {
      expect(parseJavaVersion("21.0.1+12")).toBe("21.0.1");
    });
  });

  describe("parseAdobeVersion()", () => {
    test("parses full year format", () => {
      expect(parseAdobeVersion("2024.001.20643")).toBe("2024.1.20643");
    });

    test("parses short year format", () => {
      expect(parseAdobeVersion("24.001.20643")).toBe("2024.1.20643");
    });
  });

  describe("parseCiscoVersion()", () => {
    test("parses parentheses format", () => {
      expect(parseCiscoVersion("9.18(4)")).toBe("9.18.4");
    });

    test("parses interim release", () => {
      expect(parseCiscoVersion("7.0.6-1")).toBe("7.0.61");
    });
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe("Edge cases", () => {
  let mapper: VersionMapper;

  beforeAll(() => {
    mapper = new VersionMapper();
  });

  test("empty string", () => {
    const result = mapper.map("");
    expect(result.major).toBe(0);
    expect(result.minor).toBe(0);
    expect(result.patch).toBe(0);
  });

  test("non-numeric version", () => {
    const result = mapper.map("latest");
    expect(result.original).toBe("latest");
    expect(result.normalized).toBe("latest");
    expect(result.major).toBe(0);
  });

  test("version with letters in middle", () => {
    const result = mapper.map("1.2a.3");
    expect(result.major).toBe(1);
    // parseInt("2a") returns 2
    expect(result.minor).toBe(2);
  });

  test("very long version", () => {
    const result = mapper.map("1.2.3.4.5.6.7.8");
    expect(result.major).toBe(1);
    expect(result.minor).toBe(2);
    expect(result.patch).toBe(3);
    expect(result.build).toBe(4);
  });

  test("version with only zeros", () => {
    const result = mapper.map("0.0.0");
    expect(result.major).toBe(0);
    expect(result.minor).toBe(0);
    expect(result.patch).toBe(0);
  });

  test("large version numbers", () => {
    const result = mapper.map("2024.1000.99999");
    expect(result.major).toBe(2024);
    expect(result.minor).toBe(1000);
    expect(result.patch).toBe(99999);
  });
});
