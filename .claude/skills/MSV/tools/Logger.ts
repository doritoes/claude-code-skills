/**
 * Logger.ts - Structured Logging Utility for MSV Skill
 *
 * Provides consistent logging with levels: debug, info, warn, error
 * Supports verbose mode, colored output, and structured data.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

// =============================================================================
// ANSI Color Codes
// =============================================================================

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  // Levels
  debug: "\x1b[36m",   // Cyan
  info: "\x1b[32m",    // Green
  warn: "\x1b[33m",    // Yellow
  error: "\x1b[31m",   // Red
  // Categories
  source: "\x1b[35m",  // Magenta
  version: "\x1b[36m", // Cyan
  cve: "\x1b[33m",     // Yellow
};

// =============================================================================
// Types
// =============================================================================

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LoggerOptions {
  /** Minimum level to output (default: "info") */
  level?: LogLevel;
  /** Enable verbose/debug output (default: false) */
  verbose?: boolean;
  /** Enable colored output (default: true for TTY) */
  color?: boolean;
  /** Prefix for all messages (default: none) */
  prefix?: string;
}

export interface LogContext {
  /** Source of the log (e.g., "AppThreat", "NVD", "KEV") */
  source?: string;
  /** Software being queried */
  software?: string;
  /** Operation being performed */
  operation?: string;
  /** Additional structured data */
  [key: string]: unknown;
}

// =============================================================================
// Logger Class
// =============================================================================

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export class Logger {
  private level: LogLevel;
  private verbose: boolean;
  private color: boolean;
  private prefix: string;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.verbose = options.verbose ?? false;
    this.color = options.color ?? process.stdout.isTTY ?? false;
    this.prefix = options.prefix ?? "";

    // Verbose mode implies debug level
    if (this.verbose && LEVEL_PRIORITY[this.level] > LEVEL_PRIORITY.debug) {
      this.level = "debug";
    }
  }

  /**
   * Check if a level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  /**
   * Colorize text if color is enabled
   */
  private c(color: keyof typeof COLORS, text: string): string {
    if (!this.color) return text;
    return `${COLORS[color]}${text}${COLORS.reset}`;
  }

  /**
   * Format a log message with optional context
   */
  private format(level: LogLevel, message: string, context?: LogContext): string {
    const parts: string[] = [];

    // Prefix
    if (this.prefix) {
      parts.push(this.c("dim", `[${this.prefix}]`));
    }

    // Level indicator (only for debug/warn/error)
    if (level === "debug") {
      parts.push(this.c("debug", "[DEBUG]"));
    } else if (level === "warn") {
      parts.push(this.c("warn", "[WARN]"));
    } else if (level === "error") {
      parts.push(this.c("error", "[ERROR]"));
    }

    // Source context
    if (context?.source) {
      parts.push(this.c("source", `[${context.source}]`));
    }

    // Message
    parts.push(message);

    return parts.join(" ");
  }

  /**
   * Log a debug message (only shown in verbose mode)
   */
  debug(message: string, context?: LogContext): void {
    if (!this.shouldLog("debug")) return;
    console.log(this.format("debug", message, context));
  }

  /**
   * Log an info message
   */
  info(message: string, context?: LogContext): void {
    if (!this.shouldLog("info")) return;
    console.log(this.format("info", message, context));
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: LogContext): void {
    if (!this.shouldLog("warn")) return;
    console.warn(this.format("warn", message, context));
  }

  /**
   * Log an error message
   */
  error(message: string, context?: LogContext): void {
    if (!this.shouldLog("error")) return;
    console.error(this.format("error", message, context));
  }

  /**
   * Log a progress/status message (always shown unless silent)
   */
  progress(message: string, context?: LogContext): void {
    if (this.level === "silent") return;
    const prefix = context?.source ? this.c("source", `  ${context.source}`) : " ";
    console.log(`${prefix} ${message}`);
  }

  /**
   * Log data source results
   */
  sourceResult(source: string, count: number, extra?: string): void {
    if (!this.shouldLog("info")) return;
    const countStr = count > 0
      ? this.c("info", `${count} CVEs found`)
      : this.c("dim", "0 CVEs found");
    const extraStr = extra ? this.c("dim", ` ${extra}`) : "";
    console.log(`  ${source.padEnd(14)} ${countStr}${extraStr}`);
  }

  /**
   * Log a filtered count
   */
  filtered(count: number, reason: string, context?: LogContext): void {
    if (!this.shouldLog("debug")) return;
    console.log(this.c("dim", `  Filtered ${count} CVEs ${reason}`));
  }

  /**
   * Create a child logger with additional context
   */
  child(context: LogContext): Logger {
    const child = new Logger({
      level: this.level,
      verbose: this.verbose,
      color: this.color,
      prefix: context.source || this.prefix,
    });
    return child;
  }

  /**
   * Update logger options
   */
  setOptions(options: Partial<LoggerOptions>): void {
    if (options.level !== undefined) this.level = options.level;
    if (options.verbose !== undefined) {
      this.verbose = options.verbose;
      if (this.verbose) this.level = "debug";
    }
    if (options.color !== undefined) this.color = options.color;
    if (options.prefix !== undefined) this.prefix = options.prefix;
  }

  /**
   * Check if verbose mode is enabled
   */
  isVerbose(): boolean {
    return this.verbose;
  }
}

// =============================================================================
// Default Logger Instance
// =============================================================================

/** Global logger instance - configure via setOptions() */
export const logger = new Logger();

/**
 * Create a new logger with custom options
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}
