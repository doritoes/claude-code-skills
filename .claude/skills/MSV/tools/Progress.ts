/**
 * Progress.ts - Progress Indicators for MSV Batch Operations
 *
 * Provides progress bars, spinners, and ETA calculations for
 * long-running batch operations.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

// =============================================================================
// Types
// =============================================================================

export interface ProgressOptions {
  /** Total number of items to process */
  total: number;
  /** Width of progress bar in characters */
  width?: number;
  /** Show ETA calculation */
  showEta?: boolean;
  /** Show elapsed time */
  showElapsed?: boolean;
  /** Show percentage */
  showPercent?: boolean;
  /** Show current/total count */
  showCount?: boolean;
  /** Use colors in output */
  color?: boolean;
  /** Clear line on each update (for terminal) */
  clearLine?: boolean;
  /** Prefix label */
  label?: string;
}

export interface ProgressState {
  current: number;
  total: number;
  startTime: number;
  lastUpdate: number;
  completed: boolean;
  errors: number;
  currentItem?: string;
}

// =============================================================================
// ANSI Codes
// =============================================================================

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

const CLEAR_LINE = "\r\x1b[K";

// =============================================================================
// Progress Bar
// =============================================================================

export class ProgressBar {
  private options: Required<ProgressOptions>;
  private state: ProgressState;

  constructor(options: ProgressOptions) {
    this.options = {
      total: options.total,
      width: options.width ?? 30,
      showEta: options.showEta ?? true,
      showElapsed: options.showElapsed ?? true,
      showPercent: options.showPercent ?? true,
      showCount: options.showCount ?? true,
      color: options.color ?? process.stdout.isTTY ?? false,
      clearLine: options.clearLine ?? process.stdout.isTTY ?? false,
      label: options.label ?? "Progress",
    };

    this.state = {
      current: 0,
      total: options.total,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      completed: false,
      errors: 0,
    };
  }

  /**
   * Update progress with current item
   */
  update(current: number, currentItem?: string): void {
    this.state.current = current;
    this.state.currentItem = currentItem;
    this.state.lastUpdate = Date.now();
    this.render();
  }

  /**
   * Increment progress by 1
   */
  tick(currentItem?: string): void {
    this.update(this.state.current + 1, currentItem);
  }

  /**
   * Record an error
   */
  error(): void {
    this.state.errors++;
  }

  /**
   * Mark as complete
   */
  complete(): void {
    this.state.completed = true;
    this.state.current = this.state.total;
    this.render();
    console.error(""); // New line after completion (stderr to avoid interfering with stdout data)
  }

  /**
   * Render progress bar to console
   */
  private render(): void {
    const { options, state } = this;
    const c = options.color ? COLORS : { reset: "", dim: "", green: "", yellow: "", cyan: "", red: "" };

    // Calculate percentage
    const percent = state.total > 0 ? state.current / state.total : 0;
    const percentStr = options.showPercent ? `${Math.round(percent * 100)}%` : "";

    // Build progress bar
    const filled = Math.round(percent * options.width);
    const empty = options.width - filled;
    const bar = `${c.green}${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset}`;

    // Count string
    const countStr = options.showCount
      ? `${c.cyan}${state.current}${c.dim}/${c.reset}${state.total}`
      : "";

    // Elapsed time
    const elapsed = Date.now() - state.startTime;
    const elapsedStr = options.showElapsed ? formatDuration(elapsed) : "";

    // ETA calculation
    let etaStr = "";
    if (options.showEta && state.current > 0 && !state.completed) {
      const avgTime = elapsed / state.current;
      const remaining = (state.total - state.current) * avgTime;
      etaStr = `ETA: ${formatDuration(remaining)}`;
    }

    // Current item (truncated)
    let itemStr = "";
    if (state.currentItem && !state.completed) {
      const maxLen = 20;
      const item = state.currentItem.length > maxLen
        ? state.currentItem.substring(0, maxLen - 3) + "..."
        : state.currentItem;
      itemStr = `${c.dim}${item}${c.reset}`;
    }

    // Error count
    const errorStr = state.errors > 0 ? `${c.red}${state.errors} errors${c.reset}` : "";

    // Build output line
    const parts = [
      options.label,
      `[${bar}]`,
      percentStr,
      countStr,
      elapsedStr,
      etaStr,
      itemStr,
      errorStr,
    ].filter(Boolean);

    const line = parts.join(" ");

    // Output to stderr to avoid interfering with stdout data
    if (options.clearLine) {
      process.stderr.write(CLEAR_LINE + line);
    } else {
      console.error(line);
    }
  }

  /**
   * Get current state
   */
  getState(): ProgressState {
    return { ...this.state };
  }
}

// =============================================================================
// Simple Progress Reporter (for non-TTY environments)
// =============================================================================

export class SimpleProgress {
  private total: number;
  private current: number = 0;
  private startTime: number;
  private lastReport: number = 0;
  private reportInterval: number;
  private label: string;
  private errors: number = 0;

  constructor(total: number, label = "Processing", reportInterval = 10) {
    this.total = total;
    this.label = label;
    this.reportInterval = reportInterval;
    this.startTime = Date.now();

    // Initial message (to stderr)
    console.error(`${label}: 0/${total} items...`);
  }

  /**
   * Update progress
   */
  tick(item?: string): void {
    this.current++;

    // Report every N items or at completion (to stderr)
    if (
      this.current % this.reportInterval === 0 ||
      this.current === this.total
    ) {
      const elapsed = formatDuration(Date.now() - this.startTime);
      const percent = Math.round((this.current / this.total) * 100);

      let msg = `${this.label}: ${this.current}/${this.total} (${percent}%) - ${elapsed}`;
      if (this.errors > 0) {
        msg += ` [${this.errors} errors]`;
      }
      if (item) {
        msg += ` - ${item}`;
      }

      console.error(msg);
    }
  }

  /**
   * Record an error
   */
  error(): void {
    this.errors++;
  }

  /**
   * Complete with summary (to stderr)
   */
  complete(): void {
    const elapsed = formatDuration(Date.now() - this.startTime);
    const successful = this.current - this.errors;

    console.error(
      `\n${this.label} complete: ${successful}/${this.total} successful in ${elapsed}`
    );

    if (this.errors > 0) {
      console.error(`  ${this.errors} items failed`);
    }
  }
}

// =============================================================================
// Spinner for indeterminate progress
// =============================================================================

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private message: string;
  private frameIndex: number = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private color: boolean;

  constructor(message: string, color = true) {
    this.message = message;
    this.color = color && (process.stdout.isTTY ?? false);
  }

  /**
   * Start the spinner
   */
  start(): void {
    if (!process.stderr.isTTY) {
      console.error(`${this.message}...`);
      return;
    }

    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIndex];
      const c = this.color ? COLORS.cyan : "";
      const r = this.color ? COLORS.reset : "";

      process.stderr.write(`${CLEAR_LINE}${c}${frame}${r} ${this.message}`);
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
    }, 80);
  }

  /**
   * Update spinner message
   */
  update(message: string): void {
    this.message = message;
  }

  /**
   * Stop spinner with success message
   */
  succeed(message?: string): void {
    this.stop();
    const c = this.color ? COLORS.green : "";
    const r = this.color ? COLORS.reset : "";
    console.error(`${c}✓${r} ${message || this.message}`);
  }

  /**
   * Stop spinner with failure message
   */
  fail(message?: string): void {
    this.stop();
    const c = this.color ? COLORS.red : "";
    const r = this.color ? COLORS.reset : "";
    console.error(`${c}✗${r} ${message || this.message}`);
  }

  /**
   * Stop the spinner
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (process.stderr.isTTY) {
      process.stderr.write(CLEAR_LINE);
    }
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Create appropriate progress indicator based on environment
 */
export function createProgress(
  total: number,
  label = "Processing",
  options?: Partial<ProgressOptions>
): ProgressBar | SimpleProgress {
  if (process.stdout.isTTY) {
    return new ProgressBar({ total, label, ...options });
  }
  return new SimpleProgress(total, label);
}
