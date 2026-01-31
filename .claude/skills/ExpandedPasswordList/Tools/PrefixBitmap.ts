#!/usr/bin/env bun
/**
 * PrefixBitmap.ts - Memory-efficient prefix tracking using bitmap file
 *
 * Tracks 1,048,576 prefixes (00000-FFFFF) using 128KB bitmap instead of
 * 5MB+ string array. File-backed for crash recovery.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, openSync, closeSync, writeSync, readSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TOTAL_PREFIXES = 1048576; // 16^5
const BITMAP_SIZE = Math.ceil(TOTAL_PREFIXES / 8); // 131072 bytes = 128KB

export class PrefixBitmap {
  private filePath: string;
  private fd: number | null = null;
  private buffer: Buffer;
  private dirty = false;
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;

    if (existsSync(filePath)) {
      // Load existing bitmap
      this.buffer = Buffer.from(readFileSync(filePath));
      if (this.buffer.length !== BITMAP_SIZE) {
        console.warn(`Bitmap file size mismatch, recreating`);
        this.buffer = Buffer.alloc(BITMAP_SIZE, 0);
      }
    } else {
      // Create new bitmap
      this.buffer = Buffer.alloc(BITMAP_SIZE, 0);
    }

    // Auto-flush every 5 seconds if dirty
    this.flushInterval = setInterval(() => {
      if (this.dirty) {
        this.save();
      }
    }, 5000);
  }

  /**
   * Convert 5-char hex prefix to bit index
   */
  private prefixToIndex(prefix: string): number {
    return parseInt(prefix, 16);
  }

  /**
   * Check if prefix is marked as completed
   */
  has(prefix: string): boolean {
    const index = this.prefixToIndex(prefix);
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    return (this.buffer[byteIndex] & (1 << bitIndex)) !== 0;
  }

  /**
   * Mark prefix as completed
   */
  set(prefix: string): void {
    const index = this.prefixToIndex(prefix);
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    this.buffer[byteIndex] |= (1 << bitIndex);
    this.dirty = true;
  }

  /**
   * Count completed prefixes
   */
  count(): number {
    let count = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      // Count bits set in each byte (Brian Kernighan's algorithm)
      let byte = this.buffer[i];
      while (byte) {
        byte &= byte - 1;
        count++;
      }
    }
    return count;
  }

  /**
   * Save bitmap to disk
   */
  save(): void {
    writeFileSync(this.filePath, this.buffer);
    this.dirty = false;
  }

  /**
   * Clean up interval timer
   */
  close(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.dirty) {
      this.save();
    }
  }

  /**
   * Reset bitmap (clear all bits)
   */
  reset(): void {
    this.buffer.fill(0);
    this.dirty = true;
    this.save();
  }
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dataDir = resolve(dirname(dirname(import.meta.url.replace("file:///", ""))), "data");
  const bitmapPath = resolve(dataDir, "filter-progress.bitmap");

  const bitmap = new PrefixBitmap(bitmapPath);

  if (args[0] === "--reset") {
    bitmap.reset();
    console.log("Bitmap reset");
  } else if (args[0] === "--check" && args[1]) {
    console.log(`Prefix ${args[1]}: ${bitmap.has(args[1].toUpperCase()) ? "completed" : "pending"}`);
  } else if (args[0] === "--set" && args[1]) {
    bitmap.set(args[1].toUpperCase());
    bitmap.save();
    console.log(`Prefix ${args[1]} marked as completed`);
  } else {
    console.log(`Completed prefixes: ${bitmap.count().toLocaleString()} / ${TOTAL_PREFIXES.toLocaleString()}`);
  }

  bitmap.close();
}
