/**
 * MsvError.ts - Standardized Error Handling for MSV Skill
 *
 * Provides consistent error formatting, error codes, and error types
 * for better debugging and user experience.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

// =============================================================================
// Error Codes
// =============================================================================

export enum MsvErrorCode {
  // Configuration errors (1xx)
  CONFIG_MISSING = "MSV-100",
  CONFIG_INVALID = "MSV-101",
  CATALOG_NOT_FOUND = "MSV-102",
  ENV_MISSING = "MSV-103",

  // Input errors (2xx)
  INPUT_MISSING = "MSV-200",
  INPUT_INVALID = "MSV-201",
  FILE_NOT_FOUND = "MSV-202",
  SOFTWARE_NOT_FOUND = "MSV-203",
  VERSION_INVALID = "MSV-204",

  // API errors (3xx)
  API_ERROR = "MSV-300",
  API_TIMEOUT = "MSV-301",
  API_RATE_LIMIT = "MSV-302",
  API_AUTH_FAILED = "MSV-303",
  API_UNAVAILABLE = "MSV-304",

  // Database errors (4xx)
  DB_NOT_FOUND = "MSV-400",
  DB_OUTDATED = "MSV-401",
  DB_CORRUPT = "MSV-402",
  DB_DOWNLOAD_FAILED = "MSV-403",

  // Cache errors (5xx)
  CACHE_READ_ERROR = "MSV-500",
  CACHE_WRITE_ERROR = "MSV-501",
  CACHE_CORRUPT = "MSV-502",

  // Internal errors (9xx)
  INTERNAL_ERROR = "MSV-900",
  NOT_IMPLEMENTED = "MSV-901",
}

// =============================================================================
// Error Categories
// =============================================================================

export type MsvErrorCategory =
  | "config"
  | "input"
  | "api"
  | "database"
  | "cache"
  | "internal";

const ERROR_CATEGORIES: Record<string, MsvErrorCategory> = {
  "MSV-1": "config",
  "MSV-2": "input",
  "MSV-3": "api",
  "MSV-4": "database",
  "MSV-5": "cache",
  "MSV-9": "internal",
};

// =============================================================================
// MsvError Class
// =============================================================================

export class MsvError extends Error {
  readonly code: MsvErrorCode;
  readonly category: MsvErrorCategory;
  readonly source?: string;
  readonly details?: Record<string, unknown>;
  readonly timestamp: string;

  constructor(
    code: MsvErrorCode,
    message: string,
    options?: {
      source?: string;
      details?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = "MsvError";
    this.code = code;
    this.source = options?.source;
    this.details = options?.details;
    this.timestamp = new Date().toISOString();
    this.cause = options?.cause;

    // Determine category from code prefix
    const prefix = code.substring(0, 5); // "MSV-1", "MSV-2", etc.
    this.category = ERROR_CATEGORIES[prefix] || "internal";

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MsvError);
    }
  }

  /**
   * Format error for console output
   */
  format(color = true): string {
    const RED = color ? "\x1b[31m" : "";
    const DIM = color ? "\x1b[2m" : "";
    const RESET = color ? "\x1b[0m" : "";

    let output = `${RED}[ERROR]${RESET} `;

    if (this.source) {
      output += `${DIM}[${this.source}]${RESET} `;
    }

    output += `${this.code}: ${this.message}`;

    return output;
  }

  /**
   * Format error for JSON output
   */
  toJSON(): Record<string, unknown> {
    return {
      error: true,
      code: this.code,
      category: this.category,
      message: this.message,
      source: this.source,
      details: this.details,
      timestamp: this.timestamp,
    };
  }

  /**
   * Check if error is recoverable (user can fix)
   */
  isRecoverable(): boolean {
    // Config, input, and some API errors are recoverable
    return ["config", "input"].includes(this.category) ||
           this.code === MsvErrorCode.API_RATE_LIMIT ||
           this.code === MsvErrorCode.DB_OUTDATED;
  }

  /**
   * Get user-friendly help message
   */
  getHelp(): string | null {
    switch (this.code) {
      case MsvErrorCode.CATALOG_NOT_FOUND:
        return "Ensure the MSV skill is properly installed. Check ~/.claude/skills/MSV/data/SoftwareCatalog.json";

      case MsvErrorCode.SOFTWARE_NOT_FOUND:
        return "Run 'msv list' to see supported software, or 'msv discover <name>' to add new software.";

      case MsvErrorCode.FILE_NOT_FOUND:
        return "Check the file path and ensure the file exists.";

      case MsvErrorCode.API_AUTH_FAILED:
        return this.source === "VulnCheck"
          ? "Set VULNCHECK_API_KEY environment variable. Get a free key at https://vulncheck.com"
          : this.source === "NVD"
          ? "Set NVD_API_KEY for higher rate limits. Request at https://nvd.nist.gov/developers/request-an-api-key"
          : "Check your API credentials.";

      case MsvErrorCode.API_RATE_LIMIT:
        return "Wait a few minutes and retry, or add an API key for higher limits.";

      case MsvErrorCode.DB_NOT_FOUND:
        return "Install AppThreat database: pip install appthreat-vulnerability-db[oras] && vdb --download-image";

      case MsvErrorCode.DB_OUTDATED:
        return "Update database: vdb --download-image (or msv db update)";

      default:
        return null;
    }
  }
}

// =============================================================================
// Error Factory Functions
// =============================================================================

/**
 * Create a configuration error
 */
export function configError(
  message: string,
  code: MsvErrorCode = MsvErrorCode.CONFIG_INVALID,
  details?: Record<string, unknown>
): MsvError {
  return new MsvError(code, message, { source: "Config", details });
}

/**
 * Create an input validation error
 */
export function inputError(
  message: string,
  code: MsvErrorCode = MsvErrorCode.INPUT_INVALID,
  details?: Record<string, unknown>
): MsvError {
  return new MsvError(code, message, { source: "Input", details });
}

/**
 * Create an API error
 */
export function apiError(
  source: string,
  message: string,
  code: MsvErrorCode = MsvErrorCode.API_ERROR,
  details?: Record<string, unknown>
): MsvError {
  return new MsvError(code, message, { source, details });
}

/**
 * Create a database error
 */
export function dbError(
  message: string,
  code: MsvErrorCode = MsvErrorCode.DB_NOT_FOUND,
  details?: Record<string, unknown>
): MsvError {
  return new MsvError(code, message, { source: "AppThreat", details });
}

// =============================================================================
// Error Handling Utilities
// =============================================================================

/**
 * Format any error for consistent output
 */
export function formatError(error: unknown, color = true): string {
  if (error instanceof MsvError) {
    return error.format(color);
  }

  const RED = color ? "\x1b[31m" : "";
  const RESET = color ? "\x1b[0m" : "";

  if (error instanceof Error) {
    return `${RED}[ERROR]${RESET} ${error.message}`;
  }

  return `${RED}[ERROR]${RESET} ${String(error)}`;
}

/**
 * Print error with optional help message
 */
export function printError(error: unknown, color = true): void {
  console.error(formatError(error, color));

  if (error instanceof MsvError) {
    const help = error.getHelp();
    if (help) {
      const DIM = color ? "\x1b[2m" : "";
      const RESET = color ? "\x1b[0m" : "";
      console.error(`${DIM}  Hint: ${help}${RESET}`);
    }
  }
}

/**
 * Wrap async function with error handling
 */
export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  source?: string
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MsvError) {
      throw error;
    }

    // Wrap unknown errors
    const message = error instanceof Error ? error.message : String(error);
    throw new MsvError(MsvErrorCode.INTERNAL_ERROR, message, {
      source,
      cause: error instanceof Error ? error : undefined,
    });
  }
}
