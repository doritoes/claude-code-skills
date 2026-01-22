/**
 * SbomParser.ts - SBOM (Software Bill of Materials) Parser
 *
 * Parses CycloneDX and SPDX SBOM formats for bulk compliance checking.
 * Extracts software components and versions for MSV validation.
 *
 * Supported formats:
 * - CycloneDX JSON (v1.4, v1.5, v1.6)
 * - SPDX JSON (v2.2, v2.3)
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync } from "node:fs";

// =============================================================================
// Types
// =============================================================================

export type SbomFormat = "cyclonedx" | "spdx" | "unknown";

/**
 * Normalized component from any SBOM format
 */
export interface SbomComponent {
  name: string;
  version: string;
  vendor: string | null;
  type: string;        // "library", "application", "framework", etc.
  purl: string | null; // Package URL
  cpe: string | null;  // CPE identifier
  license: string | null;
  ecosystem: string | null; // npm, pip, maven, etc.
  bomRef: string | null;    // Reference ID within the SBOM
}

/**
 * Parsed SBOM result
 */
export interface SbomParseResult {
  format: SbomFormat;
  specVersion: string;
  serialNumber: string | null;
  name: string | null;
  components: SbomComponent[];
  metadata: {
    timestamp: string | null;
    tool: string | null;
    supplier: string | null;
  };
  errors: string[];
}

// =============================================================================
// CycloneDX Types
// =============================================================================

interface CycloneDxBom {
  bomFormat?: string;
  specVersion?: string;
  serialNumber?: string;
  metadata?: {
    timestamp?: string;
    tools?: Array<{ name?: string; version?: string }> | { components?: Array<{ name?: string }> };
    component?: { name?: string; version?: string };
    supplier?: { name?: string };
  };
  components?: CycloneDxComponent[];
}

interface CycloneDxComponent {
  "bom-ref"?: string;
  type?: string;
  name?: string;
  version?: string;
  group?: string;
  purl?: string;
  cpe?: string;
  supplier?: { name?: string };
  publisher?: string;
  licenses?: Array<{ license?: { id?: string; name?: string } }>;
}

// =============================================================================
// SPDX Types
// =============================================================================

interface SpdxDocument {
  spdxVersion?: string;
  SPDXID?: string;
  name?: string;
  creationInfo?: {
    created?: string;
    creators?: string[];
  };
  packages?: SpdxPackage[];
  documentNamespace?: string;
}

interface SpdxPackage {
  SPDXID?: string;
  name?: string;
  versionInfo?: string;
  supplier?: string;
  originator?: string;
  downloadLocation?: string;
  primaryPackagePurpose?: string;
  filesAnalyzed?: boolean;
  licenseConcluded?: string;
  licenseDeclared?: string;
  externalRefs?: Array<{
    referenceCategory?: string;
    referenceType?: string;
    referenceLocator?: string;
  }>;
}

// =============================================================================
// SBOM Parser
// =============================================================================

export class SbomParser {
  /**
   * Parse SBOM from file path
   */
  parseFile(filePath: string): SbomParseResult {
    if (!existsSync(filePath)) {
      return this.errorResult(`File not found: ${filePath}`);
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      return this.parseContent(content);
    } catch (error) {
      return this.errorResult(`Failed to read file: ${error}`);
    }
  }

  /**
   * Parse SBOM from string content
   */
  parseContent(content: string): SbomParseResult {
    let json: unknown;

    try {
      json = JSON.parse(content);
    } catch {
      return this.errorResult("Invalid JSON format");
    }

    const format = this.detectFormat(json);

    switch (format) {
      case "cyclonedx":
        return this.parseCycloneDx(json as CycloneDxBom);
      case "spdx":
        return this.parseSpdx(json as SpdxDocument);
      default:
        return this.errorResult("Unrecognized SBOM format (expected CycloneDX or SPDX)");
    }
  }

  /**
   * Detect SBOM format from JSON structure
   */
  private detectFormat(json: unknown): SbomFormat {
    if (!json || typeof json !== "object") {
      return "unknown";
    }

    const obj = json as Record<string, unknown>;

    // CycloneDX has bomFormat field
    if (obj.bomFormat === "CycloneDX") {
      return "cyclonedx";
    }

    // SPDX has spdxVersion and creationInfo
    if (typeof obj.spdxVersion === "string" && obj.creationInfo) {
      return "spdx";
    }

    // CycloneDX may also be detected by specVersion + components structure
    if (obj.specVersion && obj.components && Array.isArray(obj.components)) {
      return "cyclonedx";
    }

    // SPDX can also be detected by packages array and SPDXID
    if (obj.packages && Array.isArray(obj.packages) && typeof obj.SPDXID === "string") {
      return "spdx";
    }

    return "unknown";
  }

  /**
   * Parse CycloneDX format
   */
  private parseCycloneDx(bom: CycloneDxBom): SbomParseResult {
    const errors: string[] = [];
    const components: SbomComponent[] = [];

    // Parse components
    if (bom.components && Array.isArray(bom.components)) {
      for (const comp of bom.components) {
        if (!comp.name) {
          errors.push(`Component missing name: ${JSON.stringify(comp).substring(0, 100)}`);
          continue;
        }

        const ecosystem = this.extractEcosystemFromPurl(comp.purl);
        const license = comp.licenses?.[0]?.license?.id ||
                        comp.licenses?.[0]?.license?.name || null;

        components.push({
          name: comp.name,
          version: comp.version || "unknown",
          vendor: comp.supplier?.name || comp.publisher || comp.group || null,
          type: comp.type || "library",
          purl: comp.purl || null,
          cpe: comp.cpe || null,
          license,
          ecosystem,
          bomRef: comp["bom-ref"] || null,
        });
      }
    }

    // Extract tool name
    let toolName: string | null = null;
    if (bom.metadata?.tools) {
      if (Array.isArray(bom.metadata.tools)) {
        const firstTool = bom.metadata.tools[0];
        if (firstTool?.name) {
          toolName = firstTool.name + (firstTool.version ? ` ${firstTool.version}` : "");
        }
      } else if (bom.metadata.tools.components) {
        toolName = bom.metadata.tools.components[0]?.name || null;
      }
    }

    return {
      format: "cyclonedx",
      specVersion: bom.specVersion || "unknown",
      serialNumber: bom.serialNumber || null,
      name: bom.metadata?.component?.name || null,
      components,
      metadata: {
        timestamp: bom.metadata?.timestamp || null,
        tool: toolName,
        supplier: bom.metadata?.supplier?.name || null,
      },
      errors,
    };
  }

  /**
   * Parse SPDX format
   */
  private parseSpdx(doc: SpdxDocument): SbomParseResult {
    const errors: string[] = [];
    const components: SbomComponent[] = [];

    // Parse packages
    if (doc.packages && Array.isArray(doc.packages)) {
      for (const pkg of doc.packages) {
        if (!pkg.name) {
          errors.push(`Package missing name: ${pkg.SPDXID || "unknown"}`);
          continue;
        }

        // Extract PURL and CPE from external refs
        let purl: string | null = null;
        let cpe: string | null = null;

        if (pkg.externalRefs) {
          for (const ref of pkg.externalRefs) {
            if (ref.referenceType === "purl" || ref.referenceCategory === "PACKAGE-MANAGER") {
              purl = ref.referenceLocator || null;
            }
            if (ref.referenceType === "cpe23Type" || ref.referenceType === "cpe22Type") {
              cpe = ref.referenceLocator || null;
            }
          }
        }

        // Parse vendor from supplier/originator
        const vendor = this.parseSupplierField(pkg.supplier || pkg.originator);
        const ecosystem = this.extractEcosystemFromPurl(purl);

        components.push({
          name: pkg.name,
          version: pkg.versionInfo || "unknown",
          vendor,
          type: pkg.primaryPackagePurpose?.toLowerCase() || "library",
          purl,
          cpe,
          license: pkg.licenseConcluded || pkg.licenseDeclared || null,
          ecosystem,
          bomRef: pkg.SPDXID || null,
        });
      }
    }

    // Extract tool from creators
    let toolName: string | null = null;
    if (doc.creationInfo?.creators) {
      const toolCreator = doc.creationInfo.creators.find(c => c.startsWith("Tool:"));
      if (toolCreator) {
        toolName = toolCreator.replace("Tool:", "").trim();
      }
    }

    return {
      format: "spdx",
      specVersion: doc.spdxVersion || "unknown",
      serialNumber: doc.documentNamespace || null,
      name: doc.name || null,
      components,
      metadata: {
        timestamp: doc.creationInfo?.created || null,
        tool: toolName,
        supplier: null,
      },
      errors,
    };
  }

  /**
   * Parse SPDX supplier field format
   * Format: "Organization: Name" or "Person: Name (email)"
   */
  private parseSupplierField(field: string | undefined): string | null {
    if (!field || field === "NOASSERTION") {
      return null;
    }

    // Remove prefix and email
    let result = field
      .replace(/^(Organization|Person):\s*/i, "")
      .replace(/\([^)]*\)/, "")
      .trim();

    return result || null;
  }

  /**
   * Extract ecosystem from PURL
   * Format: pkg:<ecosystem>/<namespace>/<name>@<version>
   */
  private extractEcosystemFromPurl(purl: string | null | undefined): string | null {
    if (!purl) return null;

    const match = purl.match(/^pkg:([^/]+)\//);
    if (match) {
      return match[1].toLowerCase();
    }

    return null;
  }

  /**
   * Create error result
   */
  private errorResult(message: string): SbomParseResult {
    return {
      format: "unknown",
      specVersion: "unknown",
      serialNumber: null,
      name: null,
      components: [],
      metadata: {
        timestamp: null,
        tool: null,
        supplier: null,
      },
      errors: [message],
    };
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse SBOM file and return components
 */
export function parseSbomFile(filePath: string): SbomParseResult {
  const parser = new SbomParser();
  return parser.parseFile(filePath);
}

/**
 * Parse SBOM content string and return components
 */
export function parseSbomContent(content: string): SbomParseResult {
  const parser = new SbomParser();
  return parser.parseContent(content);
}

/**
 * Map SBOM ecosystem to GHSA ecosystem
 */
export function mapToGhsaEcosystem(ecosystem: string | null): string | null {
  if (!ecosystem) return null;

  const mapping: Record<string, string> = {
    npm: "NPM",
    pypi: "PIP",
    pip: "PIP",
    maven: "MAVEN",
    nuget: "NUGET",
    gem: "RUBYGEMS",
    rubygems: "RUBYGEMS",
    composer: "COMPOSER",
    golang: "GO",
    go: "GO",
    cargo: "RUST",
    rust: "RUST",
    hex: "HEX",
    pub: "PUB",
    swift: "SWIFT",
  };

  return mapping[ecosystem.toLowerCase()] || null;
}

/**
 * Filter components that can be checked against MSV
 * (Windows software vs open source packages)
 */
export function filterWindowsComponents(components: SbomComponent[]): SbomComponent[] {
  return components.filter(comp => {
    // Include components with CPE (likely desktop software)
    if (comp.cpe) return true;

    // Include application types
    if (comp.type === "application" || comp.type === "operating-system") return true;

    // Exclude if it has a package ecosystem (npm, pip, etc.)
    if (comp.ecosystem) return false;

    // Include if no ecosystem (might be commercial software)
    return true;
  });
}

/**
 * Filter components that should be checked against GitHub Advisory DB
 */
export function filterOpenSourceComponents(components: SbomComponent[]): SbomComponent[] {
  return components.filter(comp => {
    // Must have a package ecosystem
    if (!comp.ecosystem && !comp.purl) return false;

    // Exclude applications and OS components
    if (comp.type === "application" || comp.type === "operating-system") return false;

    return true;
  });
}
