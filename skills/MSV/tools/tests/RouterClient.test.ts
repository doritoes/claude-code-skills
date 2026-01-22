/**
 * RouterClient.test.ts - Unit Tests for Router Firmware MSV
 *
 * Tests:
 * - Model lookup and fuzzy matching
 * - Hardware version resolution
 * - Firmware compliance checking
 * - Version comparison
 * - Risk scoring
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { describe, expect, test } from "bun:test";
import {
  loadCatalog,
  queryRouter,
  findModel,
  listVendors,
  listModelsByVendor,
  getCatalogStats,
  compareVersions,
  formatRouterResult,
} from "../RouterClient";

// =============================================================================
// Catalog Loading Tests
// =============================================================================

describe("RouterClient Catalog", () => {
  test("loads catalog successfully", async () => {
    const catalog = await loadCatalog();
    expect(catalog).toBeDefined();
    expect(catalog.version).toBeDefined();
    expect(catalog.vendors).toBeDefined();
    expect(catalog.models).toBeDefined();
  });

  test("catalog has expected vendors", async () => {
    const catalog = await loadCatalog();
    expect(catalog.vendors.netgear).toBeDefined();
    expect(catalog.vendors.asus).toBeDefined();
    expect(catalog.vendors.tplink).toBeDefined();
    expect(catalog.vendors.dlink).toBeDefined();
  });

  test("getCatalogStats returns valid stats", async () => {
    const stats = await getCatalogStats();
    expect(stats.vendorCount).toBeGreaterThanOrEqual(4);
    expect(stats.modelCount).toBeGreaterThanOrEqual(7);
    expect(stats.kevAffectedCount).toBeGreaterThan(0);
  });
});

// =============================================================================
// Model Lookup Tests
// =============================================================================

describe("RouterClient Model Lookup", () => {
  test("finds exact model match", async () => {
    const result = await findModel({ input: "R7000" });
    expect(result).not.toBeNull();
    expect(result?.model.model).toBe("R7000");
    expect(result?.confidence).toBeGreaterThan(0.8);
  });

  test("finds model by display name", async () => {
    const result = await findModel({ input: "NETGEAR R7000 Nighthawk" });
    expect(result).not.toBeNull();
    expect(result?.model.id).toBe("netgear_r7000");
  });

  test("finds model by alias", async () => {
    const result = await findModel({ input: "nighthawk r7000" });
    expect(result).not.toBeNull();
    expect(result?.model.id).toBe("netgear_r7000");
    expect(result?.method).toBe("alias");
  });

  test("finds TP-Link model with hyphen variations", async () => {
    const result1 = await findModel({ input: "Archer AX21" });
    const result2 = await findModel({ input: "archer-ax21" });

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1?.model.id).toBe("tplink_archer_ax21");
  });

  test("returns null for unknown model", async () => {
    const result = await findModel({ input: "UnknownRouter XYZ9999" });
    expect(result).toBeNull();
  });

  test("filters by vendor when specified", async () => {
    const result = await findModel({ input: "R7000", vendor: "asus" });
    expect(result).toBeNull(); // R7000 is NETGEAR, not ASUS
  });
});

// =============================================================================
// Query Tests
// =============================================================================

describe("RouterClient Query", () => {
  test("successful query returns model info", async () => {
    const result = await queryRouter({ input: "NETGEAR R7000" });
    expect(result.success).toBe(true);
    expect(result.model?.displayName).toBe("NETGEAR R7000 Nighthawk");
    expect(result.vendor?.displayName).toBe("NETGEAR");
    expect(result.firmwareBranch?.msv).toBe("1.0.11.134");
  });

  test("failed query returns error", async () => {
    const result = await queryRouter({ input: "XYZQWERTY99999" });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("query with firmware returns compliance status", async () => {
    const result = await queryRouter({
      input: "NETGEAR R7000",
      firmware: "1.0.11.148",
    });
    expect(result.success).toBe(true);
    expect(result.firmwareStatus).toBe("compliant");
    expect(result.userFirmware).toBe("1.0.11.148");
  });

  test("query with outdated firmware returns critical status", async () => {
    const result = await queryRouter({
      input: "NETGEAR R7000",
      firmware: "1.0.11.100",
    });
    expect(result.success).toBe(true);
    expect(result.firmwareStatus).toBe("critical"); // Below MSV with KEV CVEs
  });

  test("EOL router returns eol status", async () => {
    const result = await queryRouter({
      input: "D-Link DIR-859",
      firmware: "1.05",
    });
    expect(result.success).toBe(true);
    expect(result.firmwareStatus).toBe("eol");
    expect(result.hwVersion?.supportStatus).toBe("eol");
  });

  test("query with hardware version specifier", async () => {
    const result = await queryRouter({
      input: "TP-Link Archer AX21",
      hwVersion: "v3",
    });
    expect(result.success).toBe(true);
    expect(result.hwVersionKey).toBe("v3");
  });
});

// =============================================================================
// Version Comparison Tests
// =============================================================================

describe("RouterClient Version Comparison", () => {
  test("compares simple versions", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("compares multi-part versions", () => {
    expect(compareVersions("1.0.11.134", "1.0.11.148")).toBe(-1);
    expect(compareVersions("1.0.11.148", "1.0.11.134")).toBe(1);
  });

  test("compares ASUS underscore versions", () => {
    // ASUS uses versions like 3.0.0.4.386_51948
    expect(compareVersions("3.0.0.4.386_51948", "3.0.0.4.388_24198")).toBe(-1);
    expect(compareVersions("3.0.0.4.388_24198", "3.0.0.4.386_51948")).toBe(1);
  });

  test("handles missing parts", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1", "1.0.0.0")).toBe(0);
  });
});

// =============================================================================
// Risk Scoring Tests
// =============================================================================

describe("RouterClient Risk Scoring", () => {
  test("compliant firmware has low risk", async () => {
    const result = await queryRouter({
      input: "NETGEAR R7000",
      firmware: "1.0.11.148",
    });
    expect(result.riskScore).toBeLessThanOrEqual(30);
  });

  test("outdated firmware has higher risk", async () => {
    const result = await queryRouter({
      input: "NETGEAR R7000",
      firmware: "1.0.11.100",
    });
    expect(result.riskScore).toBeGreaterThan(50);
  });

  test("EOL device has very high risk", async () => {
    const result = await queryRouter({
      input: "D-Link DIR-859",
    });
    expect(result.riskScore).toBeGreaterThan(75);
  });

  test("low trust vendor increases risk", async () => {
    // D-Link has low trust rating
    const dlink = await queryRouter({ input: "D-Link DIR-600" });
    expect(dlink.riskScore).toBeGreaterThanOrEqual(80);
  });
});

// =============================================================================
// List Functions Tests
// =============================================================================

describe("RouterClient List Functions", () => {
  test("listVendors returns all vendors including new ones", async () => {
    const vendors = await listVendors();
    expect(vendors.length).toBeGreaterThanOrEqual(9);

    const vendorIds = vendors.map((v) => v.id);
    // Original vendors
    expect(vendorIds).toContain("netgear");
    expect(vendorIds).toContain("asus");
    expect(vendorIds).toContain("tplink");
    expect(vendorIds).toContain("dlink");
    // New vendors from Phase 2
    expect(vendorIds).toContain("zyxel");
    expect(vendorIds).toContain("mikrotik");
    expect(vendorIds).toContain("draytek");
    expect(vendorIds).toContain("tenda");
    expect(vendorIds).toContain("ubiquiti");
  });

  test("listModelsByVendor returns vendor models", async () => {
    const models = await listModelsByVendor("netgear");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.vendor === "netgear")).toBe(true);
  });

  test("listModelsByVendor returns empty for unknown vendor", async () => {
    const models = await listModelsByVendor("unknownvendor");
    expect(models.length).toBe(0);
  });
});

// =============================================================================
// Output Formatting Tests
// =============================================================================

describe("RouterClient Formatting", () => {
  test("formatRouterResult handles success", async () => {
    const result = await queryRouter({ input: "NETGEAR R7000" });
    const output = formatRouterResult(result);

    expect(output).toContain("NETGEAR R7000 Nighthawk");
    expect(output).toContain("Trust Rating: HIGH");
    expect(output).toContain("MSV");
  });

  test("formatRouterResult handles error", () => {
    const result = {
      success: false,
      error: "Model not found",
    };
    const output = formatRouterResult(result);
    expect(output).toContain("Error: Model not found");
  });

  test("formatRouterResult shows KEV CVEs", async () => {
    const result = await queryRouter({ input: "NETGEAR R7000" });
    const output = formatRouterResult(result);

    expect(output).toContain("KEV CVEs");
    expect(output).toContain("CVE-2017-5521");
  });

  test("formatRouterResult shows compliance status", async () => {
    const result = await queryRouter({
      input: "NETGEAR R7000",
      firmware: "1.0.11.148",
    });
    const output = formatRouterResult(result);

    expect(output).toContain("Your Firmware: 1.0.11.148");
    expect(output).toContain("COMPLIANT");
  });
});

// =============================================================================
// Phase 2 - New Vendor Tests
// =============================================================================

describe("RouterClient New Vendors (Phase 2)", () => {
  test("queries MikroTik RouterOS", async () => {
    const result = await queryRouter({ input: "MikroTik RouterOS" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("mikrotik");
    expect(result.firmwareBranch?.msv).toBe("6.40.5");
  });

  test("queries Zyxel firewall", async () => {
    const result = await queryRouter({ input: "Zyxel firewall" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("zyxel");
    expect(result.hwVersion?.kevCves?.length).toBeGreaterThan(0);
  });

  test("queries DrayTek Vigor", async () => {
    const result = await queryRouter({ input: "DrayTek Vigor" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("draytek");
    expect(result.vendor?.trustRating).toBe("medium-high");
  });

  test("queries Tenda AC router", async () => {
    const result = await queryRouter({ input: "Tenda AC11" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("tenda");
    expect(result.vendor?.trustRating).toBe("low");
  });

  test("queries Ubiquiti AirOS", async () => {
    const result = await queryRouter({ input: "Ubiquiti AirOS" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("ubiquiti");
    expect(result.vendor?.bugBounty).toBe(true);
  });

  test("lists D-Link models shows expanded catalog", async () => {
    const models = await listModelsByVendor("dlink");
    expect(models.length).toBeGreaterThanOrEqual(10);
  });

  test("catalog has 35+ models after Phase 2", async () => {
    const stats = await getCatalogStats();
    expect(stats.modelCount).toBeGreaterThanOrEqual(35);
    expect(stats.vendorCount).toBeGreaterThanOrEqual(9);
  });

  test("catalogs over 30 KEV-affected entries", async () => {
    const stats = await getCatalogStats();
    expect(stats.kevAffectedCount).toBeGreaterThanOrEqual(30);
  });
});

// =============================================================================
// Phase 4 - Advanced Features Tests
// =============================================================================

describe("RouterClient Phase 4 - Alternative Firmware", () => {
  test("R7000 has alternative firmware options", async () => {
    const result = await queryRouter({ input: "NETGEAR R7000" });
    expect(result.success).toBe(true);
    expect(result.hwVersion?.altFirmware).toBeDefined();
    expect(result.hwVersion?.altFirmware?.ddwrt?.status).toBe("supported");
    expect(result.hwVersion?.altFirmware?.openwrt?.status).toBe("supported");
    expect(result.hwVersion?.altFirmware?.tomato?.status).toBe("supported");
  });

  test("OpenWrt has minimum version requirement", async () => {
    const result = await queryRouter({ input: "NETGEAR R7000" });
    expect(result.hwVersion?.altFirmware?.openwrt?.minVersion).toBe("21.02");
  });

  test("Tomato shows variant name", async () => {
    const result = await queryRouter({ input: "NETGEAR R7000" });
    expect(result.hwVersion?.altFirmware?.tomato?.variant).toBe("FreshTomato");
  });

  test("formatRouterResult includes alternative firmware", async () => {
    const result = await queryRouter({ input: "NETGEAR R7000" });
    const output = formatRouterResult(result);
    expect(output).toContain("Alternative Firmware:");
    expect(output).toContain("DD-WRT");
    expect(output).toContain("OpenWrt");
    expect(output).toContain("FreshTomato");
  });
});

describe("RouterClient Phase 4 - CVE Timeline Types", () => {
  test("CveTimeline type is properly defined", () => {
    // Import the type and verify structure
    const timeline: import("../RouterTypes").CveTimeline = {
      cveId: "CVE-2023-0001",
      disclosedDate: "2023-01-15",
      kevAddedDate: "2023-02-01",
      patchedDate: "2023-01-20",
      daysToPatch: 5,
      daysSinceDisclosure: 365,
      activelyExploited: true,
    };

    expect(timeline.cveId).toBe("CVE-2023-0001");
    expect(timeline.daysToPatch).toBe(5);
    expect(timeline.activelyExploited).toBe(true);
  });

  test("RouterResult can include cveTimeline", async () => {
    const result = await queryRouter({ input: "NETGEAR R7000" });
    // cveTimeline is optional, verify the type allows it
    expect(result.cveTimeline === undefined || Array.isArray(result.cveTimeline)).toBe(true);
  });
});

describe("RouterClient Phase 4 - Batch Processing", () => {
  test("batchQuery processes multiple routers", async () => {
    const { batchQuery }: typeof import("../RouterClient") = await import("../RouterClient");

    const inventory = [
      { brand: "NETGEAR", model: "R7000" },
      { brand: "TP-Link", model: "Archer AX21" },
      { brand: "D-Link", model: "DIR-859" },
    ];

    const results = await batchQuery(inventory);
    expect(results.length).toBe(3);
    expect(results.every((r) => r.result.success)).toBe(true);
  });

  test("batchQuery includes firmware compliance check", async () => {
    const { batchQuery }: typeof import("../RouterClient") = await import("../RouterClient");

    const inventory = [
      { brand: "NETGEAR", model: "R7000", firmware: "1.0.11.148" },
    ];

    const results = await batchQuery(inventory);
    expect(results[0].result.firmwareStatus).toBe("compliant");
  });
});

// =============================================================================
// Phase 5 - ISP Gateway and Retail Expansion Tests
// =============================================================================

describe("RouterClient Phase 5 - ISP Gateways", () => {
  test("queries Xfinity XB7 gateway", async () => {
    const result = await queryRouter({ input: "Xfinity XB7" });
    expect(result.success).toBe(true);
    expect(result.model?.category).toBe("isp-gateway");
    expect(result.vendor?.id).toBe("xfinity");
  });

  test("queries Verizon Fios G3100", async () => {
    const result = await queryRouter({ input: "Verizon G3100" });
    expect(result.success).toBe(true);
    expect(result.model?.category).toBe("isp-gateway");
    expect(result.model?.ispGateway?.provider).toBe("verizon");
  });

  test("queries AT&T BGW320 gateway", async () => {
    const result = await queryRouter({ input: "AT&T BGW320" });
    expect(result.success).toBe(true);
    expect(result.model?.category).toBe("isp-gateway");
    expect(result.model?.ispGateway?.bridgeModeAvailable).toBe(false);
  });

  test("ISP gateway has OEM vendor info", async () => {
    const result = await queryRouter({ input: "Xfinity XB8" });
    expect(result.success).toBe(true);
    expect(result.model?.ispGateway?.oemVendor).toBeDefined();
    expect(result.model?.ispGateway?.autoUpdated).toBe(true);
  });
});

describe("RouterClient Phase 5 - WiFi 7 Routers", () => {
  test("queries TP-Link Archer BE550 WiFi 7", async () => {
    const result = await queryRouter({ input: "Archer BE550" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("be9300");
    expect(result.model?.releaseYear).toBe(2024);
  });

  test("queries ASUS ROG GT-BE98 Pro WiFi 7", async () => {
    const result = await queryRouter({ input: "ROG GT-BE98 Pro" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("be24000");
    expect(result.model?.category).toBe("gaming-router");
  });

  test("queries Netgear Orbi 370 WiFi 7 mesh", async () => {
    const result = await queryRouter({ input: "Orbi 370" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("be19000");
    expect(result.model?.category).toBe("mesh");
  });
});

describe("RouterClient Phase 5 - New Vendors", () => {
  test("queries Amazon eero Pro 6E", async () => {
    const result = await queryRouter({ input: "eero Pro 6E" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("amazon");
    expect(result.model?.category).toBe("mesh");
  });

  test("queries Google Nest WiFi Pro", async () => {
    const result = await queryRouter({ input: "Nest WiFi Pro" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("google");
    expect(result.vendor?.bugBounty).toBe(true);
  });

  test("queries Linksys Velop MX5300", async () => {
    const result = await queryRouter({ input: "Velop MX5300" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("linksys");
    expect(result.model?.category).toBe("mesh");
  });
});

describe("RouterClient Phase 5 - Expanded AltFirmware", () => {
  test("TP-Link Archer AX21 has OpenWrt support", async () => {
    const result = await queryRouter({ input: "Archer AX21" });
    expect(result.success).toBe(true);
    expect(result.hwVersion?.altFirmware?.openwrt?.status).toBe("supported");
    expect(result.hwVersion?.altFirmware?.openwrt?.minVersion).toBe("22.03");
  });

  test("ASUS RT-AX86U has DD-WRT and OpenWrt support", async () => {
    const result = await queryRouter({ input: "ASUS RT-AX86U" });
    expect(result.success).toBe(true);
    expect(result.hwVersion?.altFirmware?.ddwrt?.status).toBe("supported");
    expect(result.hwVersion?.altFirmware?.openwrt?.status).toBe("experimental");
  });

  test("D-Link DIR-859 EOL device shows alt firmware as option", async () => {
    const result = await queryRouter({ input: "D-Link DIR-859" });
    expect(result.success).toBe(true);
    expect(result.hwVersion?.supportStatus).toBe("eol");
    expect(result.hwVersion?.altFirmware?.openwrt?.status).toBe("supported");
    expect(result.hwVersion?.altFirmware?.ddwrt?.status).toBe("supported");
  });
});

describe("RouterClient Phase 5 - Catalog Expansion", () => {
  test("catalog has 50+ models", async () => {
    const stats = await getCatalogStats();
    expect(stats.modelCount).toBeGreaterThanOrEqual(50);
  });

  test("catalog has 15+ vendors", async () => {
    const stats = await getCatalogStats();
    expect(stats.vendorCount).toBeGreaterThanOrEqual(15);
  });

  test("listVendors includes ISP providers", async () => {
    const vendors = await listVendors();
    const vendorIds = vendors.map((v) => v.id);
    expect(vendorIds).toContain("xfinity");
    expect(vendorIds).toContain("verizon");
    expect(vendorIds).toContain("att");
  });

  test("listVendors includes new consumer vendors", async () => {
    const vendors = await listVendors();
    const vendorIds = vendors.map((v) => v.id);
    expect(vendorIds).toContain("amazon");
    expect(vendorIds).toContain("google");
    expect(vendorIds).toContain("linksys");
  });
});

// ============================================================================
// Phase 6: WFH Router Coverage Expansion (2010-present)
// ============================================================================

describe("RouterClient Phase 6 - Belkin Routers", () => {
  test("queries Belkin N750 router", async () => {
    const result = await queryRouter({ input: "Belkin N750" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("belkin");
    expect(result.model?.category).toBe("wifi-router");
    expect(result.hwVersion?.supportStatus).toBe("eol");
  });

  test("queries Belkin N600 with CVEs", async () => {
    const result = await queryRouter({ input: "Belkin N600" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("belkin");
    expect(result.firmwareBranch?.msvCves).toBeDefined();
    expect(result.firmwareBranch?.msvCves?.length).toBeGreaterThan(0);
  });

  test("queries Belkin AC1900", async () => {
    const result = await queryRouter({ input: "Belkin AC1900" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("ac1900");
  });

  test("queries Belkin range extender F9K1122", async () => {
    const result = await queryRouter({ input: "Belkin F9K1122" });
    expect(result.success).toBe(true);
    expect(result.model?.category).toBe("range-extender");
  });

  test("Belkin vendor has low trust rating", async () => {
    const result = await queryRouter({ input: "Belkin N750" });
    expect(result.success).toBe(true);
    expect(result.vendor?.trustRating).toBe("low");
  });
});

describe("RouterClient Phase 6 - ARRIS/Motorola", () => {
  test("queries ARRIS Surfboard SBG6580", async () => {
    const result = await queryRouter({ input: "SBG6580" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("arris");
    expect(result.model?.category).toBe("modem-router");
  });

  test("queries ARRIS Surfboard SBG8300 DOCSIS 3.1", async () => {
    const result = await queryRouter({ input: "ARRIS SBG8300" });
    expect(result.success).toBe(true);
    expect(result.hwVersion?.supportStatus).toBe("supported");
  });

  test("queries ARRIS NVG589 AT&T gateway", async () => {
    const result = await queryRouter({ input: "NVG589" });
    expect(result.success).toBe(true);
    expect(result.model?.ispGateway?.provider).toBe("att");
    expect(result.model?.category).toBe("isp-gateway");
  });

  test("queries ARRIS NVG599 with ISP gateway info", async () => {
    const result = await queryRouter({ input: "ARRIS NVG599" });
    expect(result.success).toBe(true);
    expect(result.model?.ispGateway?.oemVendor).toBe("Arris");
    expect(result.model?.ispGateway?.autoUpdated).toBe(true);
  });

  test("Motorola alias works for Surfboard", async () => {
    const result = await queryRouter({ input: "Motorola SBG6580" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("arris");
  });
});

describe("RouterClient Phase 6 - Buffalo AirStation", () => {
  test("queries Buffalo WZR-HP-G300NH", async () => {
    const result = await queryRouter({ input: "Buffalo WZR-HP-G300NH" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("buffalo");
    expect(result.model?.family).toBe("airstation");
  });

  test("Buffalo WZR-HP-G300NH has alt firmware support", async () => {
    const result = await queryRouter({ input: "WZR-HP-G300NH" });
    expect(result.success).toBe(true);
    expect(result.hwVersion?.altFirmware?.ddwrt?.status).toBe("supported");
    expect(result.hwVersion?.altFirmware?.openwrt?.status).toBe("supported");
  });

  test("queries Buffalo WZR-1750DHP with CVE-2021-20090", async () => {
    const result = await queryRouter({ input: "Buffalo WZR-1750DHP" });
    expect(result.success).toBe(true);
    expect(result.firmwareBranch?.msvCves).toContain("CVE-2021-20090");
  });

  test("queries Buffalo WSR-3200AX4S WiFi 6", async () => {
    const result = await queryRouter({ input: "Buffalo WSR-3200AX4S" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("ax3000");
    expect(result.hwVersion?.supportStatus).toBe("supported");
  });

  test("Buffalo vendor has medium trust rating", async () => {
    const result = await queryRouter({ input: "Buffalo AirStation" });
    expect(result.success).toBe(true);
    expect(result.vendor?.trustRating).toBe("medium");
  });
});

describe("RouterClient Phase 6 - Actiontec ISP Gateways", () => {
  test("queries Actiontec MI424WR Verizon FiOS", async () => {
    const result = await queryRouter({ input: "Actiontec MI424WR" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("actiontec");
    expect(result.model?.ispGateway?.provider).toBe("verizon");
  });

  test("Verizon FiOS router alias works", async () => {
    const result = await queryRouter({ input: "Verizon FiOS Router" });
    expect(result.success).toBe(true);
    expect(result.model?.id).toBe("actiontec_mi424wr");
  });

  test("queries Actiontec C1000A CenturyLink gateway", async () => {
    const result = await queryRouter({ input: "CenturyLink C1000A" });
    expect(result.success).toBe(true);
    expect(result.model?.ispGateway?.provider).toBe("centurylink");
  });

  test("queries Actiontec T3200 fiber gateway", async () => {
    const result = await queryRouter({ input: "Actiontec T3200" });
    expect(result.success).toBe(true);
    expect(result.model?.ispGateway?.bridgeModeAvailable).toBe(true);
    expect(result.hwVersion?.supportStatus).toBe("supported");
  });

  test("MI424WR has CSRF CVEs", async () => {
    const result = await queryRouter({ input: "MI424WR" });
    expect(result.success).toBe(true);
    expect(result.firmwareBranch?.msvCves).toContain("CVE-2014-0357");
  });
});

describe("RouterClient Phase 6 - Huawei Routers", () => {
  test("queries Huawei HG532 with KEV CVE", async () => {
    const result = await queryRouter({ input: "Huawei HG532" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("huawei");
    expect(result.hwVersion?.kevCves).toContain("CVE-2017-17215");
  });

  test("Huawei HG532 is critical KEV target", async () => {
    const result = await queryRouter({ input: "HG532" });
    expect(result.success).toBe(true);
    expect(result.firmwareBranch?.eolNote).toContain("Mirai");
  });

  test("queries Huawei WS5200", async () => {
    const result = await queryRouter({ input: "Huawei WS5200" });
    expect(result.success).toBe(true);
    expect(result.hwVersion?.supportStatus).toBe("supported");
  });

  test("queries Huawei AX3 WiFi 6", async () => {
    const result = await queryRouter({ input: "Huawei AX3" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("ax3000");
    expect(result.model?.family).toBe("ax");
  });

  test("Huawei vendor is CNA with bug bounty", async () => {
    const result = await queryRouter({ input: "Huawei HG532" });
    expect(result.success).toBe(true);
    expect(result.vendor?.cnaStatus).toBe(true);
    expect(result.vendor?.bugBounty).toBe(true);
  });
});

describe("RouterClient Phase 6 - Catalog Stats", () => {
  test("catalog has 70+ models after WFH expansion", async () => {
    const stats = await getCatalogStats();
    expect(stats.modelCount).toBeGreaterThanOrEqual(70);
  });

  test("catalog has 20+ vendors after WFH expansion", async () => {
    const stats = await getCatalogStats();
    expect(stats.vendorCount).toBeGreaterThanOrEqual(20);
  });

  test("listVendors includes new WFH vendors", async () => {
    const vendors = await listVendors();
    const vendorIds = vendors.map((v) => v.id);
    expect(vendorIds).toContain("belkin");
    expect(vendorIds).toContain("arris");
    expect(vendorIds).toContain("buffalo");
    expect(vendorIds).toContain("actiontec");
    expect(vendorIds).toContain("huawei");
  });

  test("catalog includes routers from 2010-2025 range", async () => {
    // Check that we have models from different eras
    const belkinN300 = await queryRouter({ input: "Belkin N300" });
    const huaweiAx3 = await queryRouter({ input: "Huawei AX3" });
    expect(belkinN300.model?.releaseYear).toBe(2010);
    expect(huaweiAx3.model?.releaseYear).toBe(2020);
  });
});

// ============================================================================
// Phase 7: Popular Retail Models (Newegg/Amazon Best Sellers)
// ============================================================================

describe("RouterClient Phase 7 - TP-Link Archer AX11000", () => {
  test("queries TP-Link Archer AX11000 gaming router", async () => {
    const result = await queryRouter({ input: "TP-Link Archer AX11000" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("tplink");
    expect(result.model?.category).toBe("gaming-router");
  });

  test("Archer AX11000 has CVE-2023-40357 MSV", async () => {
    const result = await queryRouter({ input: "Archer AX11000" });
    expect(result.success).toBe(true);
    expect(result.firmwareBranch?.msv).toBe("1.0.0 Build 20230523");
    expect(result.firmwareBranch?.msvCves).toContain("CVE-2023-40357");
  });

  test("Archer AX11000 is WiFi 6 tri-band", async () => {
    const result = await queryRouter({ input: "AX11000" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("ax11000");
  });
});

describe("RouterClient Phase 7 - WiFi 7 Flagship Routers", () => {
  test("queries ASUS RT-BE96U WiFi 7 flagship", async () => {
    const result = await queryRouter({ input: "ASUS RT-BE96U" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("asus");
    expect(result.model?.wifiStandard).toBe("be19000");
  });

  test("queries ASUS RT-BE88U WiFi 7", async () => {
    const result = await queryRouter({ input: "RT-BE88U" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("be9300");
  });

  test("queries NETGEAR RS700S WiFi 7", async () => {
    const result = await queryRouter({ input: "Nighthawk RS700S" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("netgear");
    expect(result.model?.wifiStandard).toBe("be19000");
  });

  test("queries NETGEAR RS90 budget WiFi 7", async () => {
    const result = await queryRouter({ input: "RS90" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("be5800");
  });
});

describe("RouterClient Phase 7 - TP-Link WiFi 7 Lineup", () => {
  test("queries Archer GE800 gaming router", async () => {
    const result = await queryRouter({ input: "TP-Link Archer GE800" });
    expect(result.success).toBe(true);
    expect(result.model?.category).toBe("gaming-router");
    expect(result.model?.wifiStandard).toBe("be19000");
  });

  test("queries Archer BE9700 best value WiFi 7", async () => {
    const result = await queryRouter({ input: "Archer BE9700" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("be9300");
  });

  test("queries Archer BE3600 budget WiFi 7", async () => {
    const result = await queryRouter({ input: "BE3600" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("be5800");
  });

  test("queries Archer AXE75 WiFi 6E", async () => {
    const result = await queryRouter({ input: "Archer AXE75" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("ax5400");
  });
});

describe("RouterClient Phase 7 - Other Popular Models", () => {
  test("queries ASUS RT-AX86U Pro", async () => {
    const result = await queryRouter({ input: "ASUS RT-AX86U Pro" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("ax5700");
  });

  test("queries Ubiquiti Dream Router 7", async () => {
    const result = await queryRouter({ input: "Ubiquiti Dream Router 7" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("ubiquiti");
    expect(result.model?.wifiStandard).toBe("be9300");
  });
});

describe("RouterClient Phase 7 - Catalog Stats", () => {
  test("catalog has 85+ models after retail expansion", async () => {
    const stats = await getCatalogStats();
    expect(stats.modelCount).toBeGreaterThanOrEqual(85);
  });

  test("catalog includes WiFi 7 models", async () => {
    const be96u = await queryRouter({ input: "RT-BE96U" });
    const ge800 = await queryRouter({ input: "GE800" });
    const rs700s = await queryRouter({ input: "RS700S" });
    expect(be96u.model?.wifiStandard).toBe("be19000");
    expect(ge800.model?.wifiStandard).toBe("be19000");
    expect(rs700s.model?.wifiStandard).toBe("be19000");
  });
});

// ============================================================================
// Phase 7b: Wavlink - CRITICAL SECURITY WARNINGS (DO NOT USE)
// ============================================================================

describe("RouterClient Phase 7 - Wavlink CRITICAL Warnings", () => {
  test("Wavlink vendor has low trust rating", async () => {
    const vendors = await listVendors();
    const wavlink = vendors.find((v) => v.id === "wavlink");
    expect(wavlink).toBeDefined();
    expect(wavlink?.trustRating).toBe("low");
  });

  test("Wavlink vendor has no bug bounty", async () => {
    const vendors = await listVendors();
    const wavlink = vendors.find((v) => v.id === "wavlink");
    expect(wavlink?.bugBounty).toBe(false);
    expect(wavlink?.cnaStatus).toBe(false);
  });

  test("queries Wavlink AC3000 - 63 CVEs", async () => {
    const result = await queryRouter({ input: "Wavlink AC3000" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("wavlink");
    expect(result.model?.displayName).toContain("CRITICAL");
  });

  test("Wavlink AC3000 has NO SAFE VERSION", async () => {
    const result = await queryRouter({ input: "Wavlink AC3000" });
    expect(result.success).toBe(true);
    expect(result.firmwareBranch?.msv).toBe("NO SAFE VERSION EXISTS");
    expect(result.firmwareBranch?.eol).toBe(true);
  });

  test("Wavlink AC3000 has never-supported status", async () => {
    const result = await queryRouter({ input: "Wavlink AC3000" });
    expect(result.success).toBe(true);
    expect(result.hwVersion?.supportStatus).toBe("never-supported");
  });

  test("queries Wavlink WN530H4 range extender", async () => {
    const result = await queryRouter({ input: "Wavlink WN530H4" });
    expect(result.success).toBe(true);
    expect(result.model?.category).toBe("range-extender");
    expect(result.hwVersion?.supportStatus).toBe("never-supported");
  });

  test("queries Wavlink WN530HG4 mesh extender", async () => {
    const result = await queryRouter({ input: "WN530HG4" });
    expect(result.success).toBe(true);
    expect(result.vendor?.id).toBe("wavlink");
    expect(result.firmwareBranch?.msv).toBe("NO SAFE VERSION EXISTS");
  });

  test("queries Wavlink WN572HG3 outdoor extender", async () => {
    const result = await queryRouter({ input: "Wavlink WN572HG3" });
    expect(result.success).toBe(true);
    expect(result.model?.category).toBe("range-extender");
    expect(result.firmwareBranch?.eolNote).toContain("REPLACE IMMEDIATELY");
  });

  test("queries Wavlink AC1200 router", async () => {
    const result = await queryRouter({ input: "Wavlink AC1200" });
    expect(result.success).toBe(true);
    expect(result.model?.wifiStandard).toBe("ac1200");
    expect(result.hwVersion?.supportStatus).toBe("never-supported");
  });

  test("queries Wavlink WL-WN578W2 extender", async () => {
    const result = await queryRouter({ input: "WL-WN578W2" });
    expect(result.success).toBe(true);
    expect(result.model?.category).toBe("range-extender");
    expect(result.firmwareBranch?.msv).toBe("NO SAFE VERSION EXISTS");
  });

  test("Wavlink AC3000 has multiple KEV CVEs", async () => {
    const result = await queryRouter({ input: "Wavlink AC3000" });
    expect(result.success).toBe(true);
    expect(result.firmwareBranch?.msvCves).toBeDefined();
    expect(result.firmwareBranch?.msvCves?.length).toBeGreaterThanOrEqual(6);
  });

  test("all Wavlink models show DO NOT USE warning", async () => {
    const models = await listModelsByVendor("wavlink");
    expect(models.length).toBeGreaterThanOrEqual(6);
    for (const model of models) {
      expect(model.displayName).toContain("CRITICAL");
      expect(model.displayName).toContain("DO NOT USE");
    }
  });

  test("Wavlink risk score is high", async () => {
    const result = await queryRouter({ input: "Wavlink AC3000" });
    expect(result.success).toBe(true);
    // Never-supported devices should have elevated risk
    expect(result.riskScore).toBeGreaterThanOrEqual(50);
  });

  test("formatRouterResult shows Wavlink critical warnings", async () => {
    const result = await queryRouter({ input: "Wavlink AC3000" });
    const output = formatRouterResult(result);
    expect(output).toContain("CRITICAL");
    expect(output).toContain("NO SAFE VERSION EXISTS");
  });
});

describe("RouterClient - Auto-Update Feature Display", () => {
  test("ISP gateway shows auto-update status", async () => {
    const result = await queryRouter({ input: "Xfinity XB7" });
    expect(result.success).toBe(true);
    expect(result.model?.ispGateway?.autoUpdated).toBe(true);
  });

  test("formatRouterResult highlights auto-update feature", async () => {
    const result = await queryRouter({ input: "Xfinity XB8" });
    const output = formatRouterResult(result);
    expect(output).toContain("AUTO-UPDATED");
    expect(output).toContain("automatically updated");
    expect(output).toContain("reduces your security risk");
  });

  test("formatRouterResult shows ISP gateway info", async () => {
    const result = await queryRouter({ input: "Verizon G3100" });
    const output = formatRouterResult(result);
    expect(output).toContain("ISP Gateway: VERIZON");
    expect(output).toContain("Bridge Mode:");
  });

  test("AT&T gateway shows no bridge mode", async () => {
    const result = await queryRouter({ input: "AT&T BGW320" });
    const output = formatRouterResult(result);
    expect(output).toContain("Bridge Mode: Not available");
  });
});

describe("RouterClient - Replacement Recommendations", () => {
  test("EOL device shows replacement recommendations", async () => {
    const result = await queryRouter({ input: "D-Link DIR-859" });
    const output = formatRouterResult(result);
    expect(output).toContain("REPLACEMENT RECOMMENDED");
    expect(output).toContain("Bug bounty program");
    expect(output).toContain("AUTO-UPDATE OPTIONS");
  });

  test("never-supported device shows replacement recommendations", async () => {
    const result = await queryRouter({ input: "Wavlink AC3000" });
    const output = formatRouterResult(result);
    expect(output).toContain("REPLACEMENT RECOMMENDED");
    expect(output).toContain("HIGH TRUST VENDORS");
  });

  test("replacement recommendations mention ISP auto-update", async () => {
    const result = await queryRouter({ input: "Wavlink AC1200" });
    const output = formatRouterResult(result);
    expect(output).toContain("ISP gateways (Xfinity, Verizon, AT&T) auto-update firmware");
  });

  test("EOL device with alt firmware shows flash option", async () => {
    const result = await queryRouter({ input: "D-Link DIR-859" });
    const output = formatRouterResult(result);
    expect(output).toContain("ALTERNATIVE: Flash DD-WRT/OpenWrt");
  });

  test("supported device does not show replacement recommendations", async () => {
    const result = await queryRouter({ input: "NETGEAR R7000", firmware: "1.0.11.148" });
    const output = formatRouterResult(result);
    expect(output).not.toContain("REPLACEMENT RECOMMENDED");
  });
});

describe("RouterClient Phase 7 - Final Catalog Stats", () => {
  test("catalog has 95+ models after Wavlink addition", async () => {
    const stats = await getCatalogStats();
    expect(stats.modelCount).toBeGreaterThanOrEqual(95);
  });

  test("catalog has 21+ vendors after Wavlink addition", async () => {
    const stats = await getCatalogStats();
    expect(stats.vendorCount).toBeGreaterThanOrEqual(21);
  });

  test("listVendors includes Wavlink", async () => {
    const vendors = await listVendors();
    const vendorIds = vendors.map((v) => v.id);
    expect(vendorIds).toContain("wavlink");
  });
});
