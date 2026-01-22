/**
 * ErrorHandling.test.ts - Unit Tests for MSV Error Handling
 *
 * Tests error classes, error codes, and error handling utilities.
 *
 * Covers:
 * - MsvError class functionality
 * - Error code categorization
 * - Error formatting (text and JSON)
 * - Error factory functions
 * - Recovery and help message logic
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { describe, expect, test } from "bun:test";
import {
  MsvError,
  MsvErrorCode,
  configError,
  inputError,
  apiError,
  dbError,
  formatError,
  withErrorHandling,
} from "../MsvError";

// =============================================================================
// MsvError Class Tests
// =============================================================================

describe("MsvError Class", () => {
  test("creates error with all properties", () => {
    const error = new MsvError(
      MsvErrorCode.SOFTWARE_NOT_FOUND,
      "Software 'foobar' not found in catalog",
      {
        source: "SoftwareCatalog",
        details: { software: "foobar" },
      }
    );

    expect(error.name).toBe("MsvError");
    expect(error.code).toBe("MSV-203");
    expect(error.category).toBe("input");
    expect(error.message).toBe("Software 'foobar' not found in catalog");
    expect(error.source).toBe("SoftwareCatalog");
    expect(error.details).toEqual({ software: "foobar" });
    expect(error.timestamp).toBeDefined();
  });

  test("inherits from Error", () => {
    const error = new MsvError(MsvErrorCode.INTERNAL_ERROR, "Test error");
    expect(error instanceof Error).toBe(true);
    expect(error instanceof MsvError).toBe(true);
  });

  test("captures cause error", () => {
    const cause = new Error("Original error");
    const error = new MsvError(MsvErrorCode.API_ERROR, "API call failed", {
      cause,
    });

    expect(error.cause).toBe(cause);
  });
});

// =============================================================================
// Error Code Category Tests
// =============================================================================

describe("Error Code Categories", () => {
  test("config errors (1xx) are category 'config'", () => {
    const errors = [
      MsvErrorCode.CONFIG_MISSING,
      MsvErrorCode.CONFIG_INVALID,
      MsvErrorCode.CATALOG_NOT_FOUND,
      MsvErrorCode.ENV_MISSING,
    ];

    for (const code of errors) {
      const error = new MsvError(code, "Test");
      expect(error.category).toBe("config");
    }
  });

  test("input errors (2xx) are category 'input'", () => {
    const errors = [
      MsvErrorCode.INPUT_MISSING,
      MsvErrorCode.INPUT_INVALID,
      MsvErrorCode.FILE_NOT_FOUND,
      MsvErrorCode.SOFTWARE_NOT_FOUND,
      MsvErrorCode.VERSION_INVALID,
    ];

    for (const code of errors) {
      const error = new MsvError(code, "Test");
      expect(error.category).toBe("input");
    }
  });

  test("API errors (3xx) are category 'api'", () => {
    const errors = [
      MsvErrorCode.API_ERROR,
      MsvErrorCode.API_TIMEOUT,
      MsvErrorCode.API_RATE_LIMIT,
      MsvErrorCode.API_AUTH_FAILED,
      MsvErrorCode.API_UNAVAILABLE,
    ];

    for (const code of errors) {
      const error = new MsvError(code, "Test");
      expect(error.category).toBe("api");
    }
  });

  test("database errors (4xx) are category 'database'", () => {
    const errors = [
      MsvErrorCode.DB_NOT_FOUND,
      MsvErrorCode.DB_OUTDATED,
      MsvErrorCode.DB_CORRUPT,
      MsvErrorCode.DB_DOWNLOAD_FAILED,
    ];

    for (const code of errors) {
      const error = new MsvError(code, "Test");
      expect(error.category).toBe("database");
    }
  });

  test("cache errors (5xx) are category 'cache'", () => {
    const errors = [
      MsvErrorCode.CACHE_READ_ERROR,
      MsvErrorCode.CACHE_WRITE_ERROR,
      MsvErrorCode.CACHE_CORRUPT,
    ];

    for (const code of errors) {
      const error = new MsvError(code, "Test");
      expect(error.category).toBe("cache");
    }
  });

  test("internal errors (9xx) are category 'internal'", () => {
    const errors = [
      MsvErrorCode.INTERNAL_ERROR,
      MsvErrorCode.NOT_IMPLEMENTED,
    ];

    for (const code of errors) {
      const error = new MsvError(code, "Test");
      expect(error.category).toBe("internal");
    }
  });
});

// =============================================================================
// Error Formatting Tests
// =============================================================================

describe("Error Formatting", () => {
  test("format() returns colored output by default", () => {
    const error = new MsvError(MsvErrorCode.API_ERROR, "Request failed", {
      source: "VulnCheck",
    });

    const formatted = error.format();
    expect(formatted).toContain("[ERROR]");
    expect(formatted).toContain("[VulnCheck]");
    expect(formatted).toContain("MSV-300");
    expect(formatted).toContain("Request failed");
  });

  test("format() can disable colors", () => {
    const error = new MsvError(MsvErrorCode.API_ERROR, "Request failed", {
      source: "VulnCheck",
    });

    const formatted = error.format(false);
    expect(formatted).not.toContain("\x1b["); // No ANSI codes
    expect(formatted).toContain("[ERROR]");
    expect(formatted).toContain("MSV-300");
  });

  test("toJSON() returns structured object", () => {
    const error = new MsvError(MsvErrorCode.SOFTWARE_NOT_FOUND, "Not found", {
      source: "Catalog",
      details: { query: "foobar" },
    });

    const json = error.toJSON();
    expect(json.error).toBe(true);
    expect(json.code).toBe("MSV-203");
    expect(json.category).toBe("input");
    expect(json.message).toBe("Not found");
    expect(json.source).toBe("Catalog");
    expect(json.details).toEqual({ query: "foobar" });
    expect(json.timestamp).toBeDefined();
  });
});

// =============================================================================
// Error Recoverability Tests
// =============================================================================

describe("Error Recoverability", () => {
  test("config errors are recoverable", () => {
    const error = new MsvError(MsvErrorCode.CONFIG_MISSING, "Config missing");
    expect(error.isRecoverable()).toBe(true);
  });

  test("input errors are recoverable", () => {
    const error = new MsvError(MsvErrorCode.INPUT_INVALID, "Invalid input");
    expect(error.isRecoverable()).toBe(true);
  });

  test("rate limit errors are recoverable", () => {
    const error = new MsvError(MsvErrorCode.API_RATE_LIMIT, "Rate limited");
    expect(error.isRecoverable()).toBe(true);
  });

  test("database outdated errors are recoverable", () => {
    const error = new MsvError(MsvErrorCode.DB_OUTDATED, "DB outdated");
    expect(error.isRecoverable()).toBe(true);
  });

  test("internal errors are not recoverable", () => {
    const error = new MsvError(MsvErrorCode.INTERNAL_ERROR, "Internal error");
    expect(error.isRecoverable()).toBe(false);
  });

  test("generic API errors are not recoverable", () => {
    const error = new MsvError(MsvErrorCode.API_UNAVAILABLE, "Service down");
    expect(error.isRecoverable()).toBe(false);
  });
});

// =============================================================================
// Help Message Tests
// =============================================================================

describe("Help Messages", () => {
  test("SOFTWARE_NOT_FOUND provides list hint", () => {
    const error = new MsvError(MsvErrorCode.SOFTWARE_NOT_FOUND, "Not found");
    const help = error.getHelp();
    expect(help).toContain("msv list");
    expect(help).toContain("msv discover");
  });

  test("FILE_NOT_FOUND provides path hint", () => {
    const error = new MsvError(MsvErrorCode.FILE_NOT_FOUND, "File not found");
    const help = error.getHelp();
    expect(help).toContain("file path");
  });

  test("API_AUTH_FAILED provides VulnCheck hint", () => {
    const error = new MsvError(MsvErrorCode.API_AUTH_FAILED, "Auth failed", {
      source: "VulnCheck",
    });
    const help = error.getHelp();
    expect(help).toContain("VULNCHECK_API_KEY");
    expect(help).toContain("vulncheck.com");
  });

  test("API_AUTH_FAILED provides NVD hint", () => {
    const error = new MsvError(MsvErrorCode.API_AUTH_FAILED, "Auth failed", {
      source: "NVD",
    });
    const help = error.getHelp();
    expect(help).toContain("NVD_API_KEY");
  });

  test("DB_NOT_FOUND provides installation hint", () => {
    const error = new MsvError(MsvErrorCode.DB_NOT_FOUND, "Database missing");
    const help = error.getHelp();
    expect(help).toContain("vdb --download-image");
  });

  test("internal errors have no help", () => {
    const error = new MsvError(MsvErrorCode.INTERNAL_ERROR, "Bug");
    expect(error.getHelp()).toBeNull();
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe("Error Factory Functions", () => {
  test("configError creates config error", () => {
    const error = configError("Missing config file");
    expect(error.category).toBe("config");
    expect(error.source).toBe("Config");
  });

  test("inputError creates input error", () => {
    const error = inputError("Invalid format", MsvErrorCode.INPUT_INVALID, {
      input: "bad",
    });
    expect(error.category).toBe("input");
    expect(error.source).toBe("Input");
    expect(error.details?.input).toBe("bad");
  });

  test("apiError creates API error with source", () => {
    const error = apiError("VulnCheck", "Timeout", MsvErrorCode.API_TIMEOUT);
    expect(error.category).toBe("api");
    expect(error.source).toBe("VulnCheck");
  });

  test("dbError creates database error", () => {
    const error = dbError("Database not found");
    expect(error.category).toBe("database");
    expect(error.source).toBe("AppThreat");
  });
});

// =============================================================================
// formatError Utility Tests
// =============================================================================

describe("formatError Utility", () => {
  test("formats MsvError", () => {
    const error = new MsvError(MsvErrorCode.API_ERROR, "Test");
    const formatted = formatError(error);
    expect(formatted).toContain("[ERROR]");
    expect(formatted).toContain("MSV-300");
  });

  test("formats regular Error", () => {
    const error = new Error("Regular error");
    const formatted = formatError(error, false);
    expect(formatted).toContain("[ERROR]");
    expect(formatted).toContain("Regular error");
  });

  test("formats string error", () => {
    const formatted = formatError("String error", false);
    expect(formatted).toContain("[ERROR]");
    expect(formatted).toContain("String error");
  });

  test("formats unknown types", () => {
    const formatted = formatError(42, false);
    expect(formatted).toContain("[ERROR]");
    expect(formatted).toContain("42");
  });
});

// =============================================================================
// withErrorHandling Utility Tests
// =============================================================================

describe("withErrorHandling Utility", () => {
  test("passes through successful result", async () => {
    const result = await withErrorHandling(async () => "success");
    expect(result).toBe("success");
  });

  test("passes through MsvError unchanged", async () => {
    const original = new MsvError(MsvErrorCode.API_ERROR, "API failed");

    await expect(
      withErrorHandling(async () => {
        throw original;
      })
    ).rejects.toBe(original);
  });

  test("wraps regular Error in MsvError", async () => {
    await expect(
      withErrorHandling(
        async () => {
          throw new Error("Something broke");
        },
        "TestSource"
      )
    ).rejects.toMatchObject({
      code: MsvErrorCode.INTERNAL_ERROR,
      source: "TestSource",
      message: "Something broke",
    });
  });

  test("wraps string throws in MsvError", async () => {
    await expect(
      withErrorHandling(async () => {
        throw "string error";
      })
    ).rejects.toMatchObject({
      code: MsvErrorCode.INTERNAL_ERROR,
      message: "string error",
    });
  });
});

// =============================================================================
// Edge Case Tests
// =============================================================================

describe("Error Edge Cases", () => {
  test("error with empty message", () => {
    const error = new MsvError(MsvErrorCode.INTERNAL_ERROR, "");
    expect(error.message).toBe("");
    expect(error.format()).toContain("MSV-900:");
  });

  test("error with very long message", () => {
    const longMessage = "x".repeat(10000);
    const error = new MsvError(MsvErrorCode.INTERNAL_ERROR, longMessage);
    expect(error.message.length).toBe(10000);
  });

  test("error with special characters in message", () => {
    const message = "Error: <script>alert('xss')</script> & \"quotes\"";
    const error = new MsvError(MsvErrorCode.INTERNAL_ERROR, message);
    expect(error.message).toBe(message);

    // JSON output should be safe
    const json = error.toJSON();
    expect(json.message).toBe(message);
  });

  test("error with undefined details", () => {
    const error = new MsvError(MsvErrorCode.INTERNAL_ERROR, "Test");
    expect(error.details).toBeUndefined();
    expect(error.toJSON().details).toBeUndefined();
  });

  test("error without source", () => {
    const error = new MsvError(MsvErrorCode.INTERNAL_ERROR, "Test");
    expect(error.source).toBeUndefined();

    const formatted = error.format();
    expect(formatted).not.toContain("[]"); // No empty source brackets
  });
});
