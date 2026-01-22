/**
 * DataContamination.test.ts - Tests for Data Contamination Filtering
 *
 * Verifies that the excludePatterns and versionPattern filters correctly
 * prevent cross-product CVE contamination.
 *
 * Real examples from the catalog:
 * - Git should not include GitLab, Gitea, or GitHub CVEs
 * - OpenSSL should not include pyOpenSSL or ruby-openssl CVEs
 * - Python should not include VSCode Python extension CVEs
 * - Docker Desktop should not include Remote Desktop CVEs
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { describe, expect, test } from "bun:test";

// =============================================================================
// Filter Helper Functions (matching msv.ts logic)
// =============================================================================

/**
 * Filter CVE results by version pattern
 * Mirrors the logic in msv.ts queryMSV function
 */
function filterByVersionPattern(
  results: Array<{ fixedVersion?: string; cveId: string }>,
  versionPattern: string
): Array<{ fixedVersion?: string; cveId: string }> {
  const versionRegex = new RegExp(versionPattern);
  return results.filter((r) => {
    if (!r.fixedVersion) return true; // Keep CVEs without fixed version
    return versionRegex.test(r.fixedVersion);
  });
}

/**
 * Filter CVE results by exclude patterns (description matching)
 * Mirrors the logic in msv.ts queryMSV function
 */
function filterByExcludePatterns(
  results: Array<{ description?: string; cveId: string }>,
  excludePatterns: string[]
): Array<{ description?: string; cveId: string }> {
  const excludeRegexes = excludePatterns.map((p) => new RegExp(p, "i"));
  return results.filter((r) => {
    const desc = r.description || "";
    for (const regex of excludeRegexes) {
      if (regex.test(desc)) {
        return false; // Exclude this CVE
      }
    }
    return true;
  });
}

// =============================================================================
// Version Pattern Filtering Tests
// =============================================================================

describe("Version Pattern Filtering", () => {
  describe("Python version filter (^3\\.)", () => {
    const versionPattern = "^3\\.";

    test("keeps Python 3.x versions", () => {
      const results = [
        { cveId: "CVE-2024-0001", fixedVersion: "3.11.5" },
        { cveId: "CVE-2024-0002", fixedVersion: "3.12.0" },
        { cveId: "CVE-2024-0003", fixedVersion: "3.9.18" },
      ];
      const filtered = filterByVersionPattern(results, versionPattern);
      expect(filtered.length).toBe(3);
    });

    test("excludes Python 2.x versions", () => {
      const results = [
        { cveId: "CVE-2024-0001", fixedVersion: "2.7.18" },
        { cveId: "CVE-2024-0002", fixedVersion: "3.11.5" },
      ];
      const filtered = filterByVersionPattern(results, versionPattern);
      expect(filtered.length).toBe(1);
      expect(filtered[0].fixedVersion).toBe("3.11.5");
    });

    test("keeps CVEs without fixed version", () => {
      const results = [
        { cveId: "CVE-2024-0001", fixedVersion: undefined },
        { cveId: "CVE-2024-0002", fixedVersion: "3.11.5" },
      ];
      const filtered = filterByVersionPattern(results, versionPattern);
      expect(filtered.length).toBe(2);
    });
  });

  describe("Git version filter (^2\\.)", () => {
    const versionPattern = "^2\\.";

    test("keeps Git 2.x versions", () => {
      const results = [
        { cveId: "CVE-2024-0001", fixedVersion: "2.43.0" },
        { cveId: "CVE-2024-0002", fixedVersion: "2.42.1" },
      ];
      const filtered = filterByVersionPattern(results, versionPattern);
      expect(filtered.length).toBe(2);
    });

    test("excludes Git 1.x versions (legacy)", () => {
      const results = [
        { cveId: "CVE-2024-0001", fixedVersion: "1.9.5" },
        { cveId: "CVE-2024-0002", fixedVersion: "2.43.0" },
      ];
      const filtered = filterByVersionPattern(results, versionPattern);
      expect(filtered.length).toBe(1);
    });
  });

  describe("OpenSSL version filter (^[013]\\.)", () => {
    const versionPattern = "^[013]\\.";

    test("keeps OpenSSL 1.x and 3.x versions", () => {
      const results = [
        { cveId: "CVE-2024-0001", fixedVersion: "1.1.1w" },
        { cveId: "CVE-2024-0002", fixedVersion: "3.0.12" },
        { cveId: "CVE-2024-0003", fixedVersion: "3.1.4" },
      ];
      const filtered = filterByVersionPattern(results, versionPattern);
      expect(filtered.length).toBe(3);
    });

    test("excludes invalid version formats", () => {
      const results = [
        { cveId: "CVE-2024-0001", fixedVersion: "22.0.0" }, // pyOpenSSL version
        { cveId: "CVE-2024-0002", fixedVersion: "3.0.12" },
      ];
      const filtered = filterByVersionPattern(results, versionPattern);
      expect(filtered.length).toBe(1);
    });
  });

  describe("PowerShell 7 version filter (^7\\.)", () => {
    const versionPattern = "^7\\.";

    test("keeps PowerShell 7.x versions only", () => {
      const results = [
        { cveId: "CVE-2024-0001", fixedVersion: "7.4.0" },
        { cveId: "CVE-2024-0002", fixedVersion: "5.1.0" }, // Windows PowerShell
        { cveId: "CVE-2024-0003", fixedVersion: "7.2.15" },
      ];
      const filtered = filterByVersionPattern(results, versionPattern);
      expect(filtered.length).toBe(2);
      expect(filtered.every((r) => r.fixedVersion?.startsWith("7."))).toBe(true);
    });
  });
});

// =============================================================================
// Exclude Patterns Filtering Tests
// =============================================================================

describe("Exclude Patterns Filtering", () => {
  describe("Git exclude patterns", () => {
    const excludePatterns = [
      "\\bgitlab\\b",
      "\\bgitea\\b",
      "\\bgithub\\b",
      "\\bgit-lfs\\b",
      "\\bgit server\\b",
      "\\bliferay\\b",
    ];

    test("keeps genuine Git CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "Git before 2.43.0 allows arbitrary code execution",
        },
        {
          cveId: "CVE-2024-0002",
          description: "A vulnerability in git clone affects Windows users",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(2);
    });

    test("excludes GitLab CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "GitLab CE/EE allows remote code execution",
        },
        {
          cveId: "CVE-2024-0002",
          description: "Git before 2.43.0 allows arbitrary code execution",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(1);
      expect(filtered[0].cveId).toBe("CVE-2024-0002");
    });

    test("excludes Gitea CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "Gitea before 1.19 has XSS vulnerability",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });

    test("excludes GitHub CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "GitHub Enterprise Server allows SSRF",
        },
        {
          cveId: "CVE-2024-0002",
          description: "github.com API vulnerability in authentication",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });

    test("excludes git-lfs CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "Git LFS before 3.3.0 allows code execution via git-lfs",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });

    test("excludes Liferay CVEs (common false positive)", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "Liferay Portal has Git integration vulnerability",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });
  });

  describe("OpenSSL exclude patterns", () => {
    const excludePatterns = [
      "\\bpyopenssl\\b",
      "\\bpython.*openssl\\b",
      "\\brubyopenssl\\b",
      "\\bopenssl-src\\b",
      "\\brust-openssl\\b",
    ];

    test("keeps genuine OpenSSL CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "OpenSSL 3.0.x before 3.0.12 has buffer overflow",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(1);
    });

    test("excludes pyOpenSSL CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "pyOpenSSL before 22.0 allows certificate bypass",
        },
        {
          cveId: "CVE-2024-0002",
          description: "PyOpenSSL memory corruption vulnerability",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });

    test("excludes ruby-openssl CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "rubyopenssl gem allows man-in-the-middle",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });

    test("excludes Rust openssl-src CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "openssl-src crate bundles vulnerable OpenSSL",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });
  });

  describe("Python exclude patterns", () => {
    const excludePatterns = [
      "\\bvscode\\b",
      "\\bvisual studio code\\b",
      "\\bpython extension\\b",
      "\\bpylint\\b",
      "\\bpython-ldap\\b",
      "\\bdjango\\b",
      "\\bflask\\b",
    ];

    test("keeps genuine Python CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "Python 3.11 before 3.11.5 has HTTP header injection",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(1);
    });

    test("excludes VSCode Python extension CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "VSCode Python extension allows code execution",
        },
        {
          cveId: "CVE-2024-0002",
          description: "Visual Studio Code debugger vulnerability",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });

    test("excludes Django framework CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "Django before 4.2.8 has SQL injection",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });

    test("excludes Flask framework CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "Flask session cookie vulnerability",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });
  });

  describe("Docker Desktop exclude patterns", () => {
    const excludePatterns = [
      "\\bremote desktop\\b",
      "\\bwindows.*desktop\\b",
      "\\brdp\\b",
      "\\bkubernetes\\b",
      "\\bcontainerd\\b",
    ];

    test("keeps genuine Docker Desktop CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "Docker Desktop before 4.26.0 allows privilege escalation",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(1);
    });

    test("excludes Remote Desktop CVEs", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "Windows Remote Desktop allows code execution",
        },
        {
          cveId: "CVE-2024-0002",
          description: "RDP protocol vulnerability in Windows Server",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });

    test("excludes containerd CVEs (different product)", () => {
      const results = [
        {
          cveId: "CVE-2024-0001",
          description: "containerd before 1.6.0 allows container escape",
        },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });
  });

  describe("Case Insensitivity", () => {
    test("exclude patterns are case insensitive", () => {
      const excludePatterns = ["\\bgitlab\\b"];
      const results = [
        { cveId: "CVE-2024-0001", description: "GITLAB vulnerability" },
        { cveId: "CVE-2024-0002", description: "GitLab issue" },
        { cveId: "CVE-2024-0003", description: "gitlab CE/EE" },
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(0);
    });
  });

  describe("Word Boundary Matching", () => {
    test("word boundaries prevent partial matches", () => {
      const excludePatterns = ["\\bgit\\b"];
      const results = [
        { cveId: "CVE-2024-0001", description: "Git vulnerability" }, // Should match
        { cveId: "CVE-2024-0002", description: "digital signature" }, // Should NOT match ('digit')
        { cveId: "CVE-2024-0003", description: "legitimate access" }, // Should NOT match ('legit')
      ];
      const filtered = filterByExcludePatterns(results, excludePatterns);
      expect(filtered.length).toBe(2); // 'digital' and 'legitimate' kept
    });
  });
});

// =============================================================================
// Combined Filter Tests
// =============================================================================

describe("Combined Filtering", () => {
  test("both version and exclude patterns applied", () => {
    const versionPattern = "^2\\.";
    const excludePatterns = ["\\bgitlab\\b", "\\bgithub\\b"];

    const results = [
      { cveId: "CVE-2024-0001", fixedVersion: "2.43.0", description: "Git vulnerability" },
      { cveId: "CVE-2024-0002", fixedVersion: "1.9.5", description: "Git vulnerability" }, // Wrong version
      { cveId: "CVE-2024-0003", fixedVersion: "2.40.0", description: "GitLab vulnerability" }, // Excluded
      { cveId: "CVE-2024-0004", fixedVersion: "2.41.0", description: "GitHub issue" }, // Excluded
    ];

    // Apply version filter first
    let filtered = filterByVersionPattern(results, versionPattern);
    expect(filtered.length).toBe(3); // CVE-2024-0002 removed

    // Then apply exclude patterns
    filtered = filterByExcludePatterns(filtered, excludePatterns);
    expect(filtered.length).toBe(1); // Only CVE-2024-0001 remains
    expect(filtered[0].cveId).toBe("CVE-2024-0001");
  });
});
