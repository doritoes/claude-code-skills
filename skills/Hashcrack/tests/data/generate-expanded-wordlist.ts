#!/usr/bin/env bun
/**
 * Generate expanded wordlist for smoke tests
 * Target: ~150,000 words to create ~84M keyspace (with 561 rules)
 * This ensures enough chunks for both workers even with fast SHA256 CPU benchmarks (2M+ H/s)
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The 10 test passwords that must remain crackable
const PASSWORDS = [
  "1993",
  "angel04",
  "bella27",
  "coolsebastian",
  "felix11",
  "jennifer2025",
  "lovejean",
  "october2011",
  "sexy666",
  "virtual"
];

// Target positions for password distribution (as percentage of total)
// These ensure passwords are spread across the entire keyspace
const PASSWORD_POSITIONS = [
  0.006,  // 0.6%  - near start
  0.063,  // 6.3%  - early
  0.126,  // 12.6% - first quarter
  0.252,  // 25.2% - quarter mark
  0.378,  // 37.8% - first third+
  0.503,  // 50.3% - middle
  0.629,  // 62.9% - past middle
  0.755,  // 75.5% - third quarter
  0.881,  // 88.1% - near end
  0.975   // 97.5% - very end
];

// Common password patterns to use as filler words
const COMMON_NAMES = [
  "michael", "christopher", "matthew", "joshua", "daniel", "david", "james", "robert",
  "john", "joseph", "andrew", "ryan", "brandon", "jason", "justin", "william",
  "ashley", "jessica", "amanda", "sarah", "stephanie", "jennifer", "elizabeth", "lauren",
  "emily", "megan", "samantha", "nicole", "brittany", "hannah", "kayla", "alexis",
  "alex", "chris", "mike", "matt", "josh", "dan", "dave", "jim", "joe", "andy",
  "charlie", "frank", "george", "harry", "jack", "kevin", "larry", "mark", "nick", "paul",
  "peter", "richard", "steve", "thomas", "tony", "victor", "walter", "adam", "brian", "carl"
];

const COMMON_WORDS = [
  "password", "welcome", "admin", "login", "master", "secret", "letmein", "trustno1",
  "dragon", "monkey", "shadow", "sunshine", "princess", "football", "baseball", "soccer",
  "hockey", "basketball", "tennis", "golf", "swimming", "running", "skiing", "surfing",
  "summer", "winter", "spring", "autumn", "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december", "computer", "internet",
  "network", "server", "client", "database", "system", "program", "software", "hardware",
  "apple", "orange", "banana", "cherry", "grape", "lemon", "peach", "mango", "berry", "melon",
  "coffee", "chocolate", "cookie", "pizza", "burger", "chicken", "steak", "pasta", "salad",
  "music", "guitar", "piano", "drums", "violin", "trumpet", "flute", "saxophone", "bass",
  "movie", "action", "comedy", "drama", "horror", "romance", "thriller", "fantasy", "scifi"
];

const ANIMALS = [
  "tiger", "lion", "bear", "wolf", "eagle", "shark", "dolphin", "whale", "elephant", "monkey",
  "cat", "dog", "bird", "fish", "horse", "cow", "pig", "sheep", "goat", "chicken",
  "rabbit", "mouse", "snake", "lizard", "frog", "turtle", "spider", "butterfly", "bee", "ant"
];

const COLORS = [
  "red", "blue", "green", "yellow", "orange", "purple", "pink", "black", "white", "gray",
  "brown", "gold", "silver", "bronze", "cyan", "magenta", "violet", "indigo", "crimson", "navy"
];

// Generate variations of a word
function generateVariations(word: string): string[] {
  const variations: string[] = [word];

  // Add number suffixes
  for (let i = 0; i <= 99; i++) {
    variations.push(`${word}${i}`);
    variations.push(`${word}${i.toString().padStart(2, '0')}`);
  }

  // Add year suffixes
  for (let year = 1970; year <= 2030; year++) {
    variations.push(`${word}${year}`);
  }

  // Add common special char suffixes
  variations.push(`${word}!`);
  variations.push(`${word}@`);
  variations.push(`${word}#`);
  variations.push(`${word}123`);
  variations.push(`${word}1234`);

  return variations;
}

// Generate number patterns
function generateNumberPatterns(): string[] {
  const patterns: string[] = [];

  // Years
  for (let year = 1950; year <= 2030; year++) {
    patterns.push(year.toString());
  }

  // Common number sequences
  for (let i = 0; i <= 9999; i++) {
    if (i < 10) patterns.push(i.toString());
    if (i < 100) patterns.push(i.toString().padStart(2, '0'));
    if (i < 1000) patterns.push(i.toString().padStart(3, '0'));
    patterns.push(i.toString().padStart(4, '0'));
  }

  // Repeated digits
  for (let d = 0; d <= 9; d++) {
    for (let len = 1; len <= 8; len++) {
      patterns.push(d.toString().repeat(len));
    }
  }

  // Sequential patterns
  patterns.push("123456", "1234567", "12345678", "123456789", "1234567890");
  patterns.push("0123456789", "9876543210", "0987654321");
  patterns.push("121212", "123123", "112233", "11223344");

  return patterns;
}

// Generate letter patterns
function generateLetterPatterns(): string[] {
  const patterns: string[] = [];
  const letters = "abcdefghijklmnopqrstuvwxyz";

  // Single letters through 4-letter combinations
  for (const a of letters) {
    patterns.push(a);
    for (const b of letters) {
      patterns.push(a + b);
      for (const c of letters.slice(0, 10)) { // Limit to keep size manageable
        patterns.push(a + b + c);
      }
    }
  }

  // Common letter sequences
  patterns.push("qwerty", "qwertyuiop", "asdf", "asdfgh", "zxcvbn");
  patterns.push("abcdef", "abcdefgh", "abc123", "xyz123");

  return patterns;
}

function main() {
  console.log("Generating expanded wordlist for smoke tests...\n");

  const TARGET_SIZE = 150000;

  // Collect all filler words
  const fillerWords = new Set<string>();

  // Add common names with variations
  console.log("Adding name variations...");
  for (const name of COMMON_NAMES) {
    for (const v of generateVariations(name)) {
      fillerWords.add(v);
    }
  }

  // Add common words with variations
  console.log("Adding word variations...");
  for (const word of COMMON_WORDS) {
    for (const v of generateVariations(word)) {
      fillerWords.add(v);
    }
  }

  // Add animals with variations
  console.log("Adding animal variations...");
  for (const animal of ANIMALS) {
    for (const v of generateVariations(animal)) {
      fillerWords.add(v);
    }
  }

  // Add colors with variations
  console.log("Adding color variations...");
  for (const color of COLORS) {
    for (const v of generateVariations(color)) {
      fillerWords.add(v);
    }
  }

  // Add number patterns
  console.log("Adding number patterns...");
  for (const p of generateNumberPatterns()) {
    fillerWords.add(p);
  }

  // Add letter patterns
  console.log("Adding letter patterns...");
  for (const p of generateLetterPatterns()) {
    fillerWords.add(p);
  }

  console.log(`\nTotal unique filler words: ${fillerWords.size}`);

  // Remove passwords from filler (we'll place them at specific positions)
  for (const pwd of PASSWORDS) {
    fillerWords.delete(pwd);
  }

  // Convert to sorted array
  let fillerArray = Array.from(fillerWords).sort();

  // Ensure we have enough filler
  if (fillerArray.length + PASSWORDS.length < TARGET_SIZE) {
    console.log(`Warning: Only ${fillerArray.length} filler words. Adding more patterns...`);
    // Add more combinations if needed
    const extras: string[] = [];
    for (let i = 0; extras.length + fillerArray.length < TARGET_SIZE - 10; i++) {
      const word = `filler${i.toString().padStart(5, '0')}`;
      if (!fillerWords.has(word)) {
        extras.push(word);
      }
    }
    fillerArray = fillerArray.concat(extras).sort();
  }

  // Trim to target size minus passwords
  fillerArray = fillerArray.slice(0, TARGET_SIZE - PASSWORDS.length);

  console.log(`Using ${fillerArray.length} filler words + ${PASSWORDS.length} passwords = ${fillerArray.length + PASSWORDS.length} total`);

  // Build final wordlist with passwords at specific positions
  const finalWordlist: string[] = [];
  let fillerIndex = 0;

  // Calculate password positions
  const totalSize = fillerArray.length + PASSWORDS.length;
  const passwordLineNumbers = PASSWORD_POSITIONS.map(p => Math.floor(p * totalSize));

  console.log("\nPassword positions:");
  for (let i = 0; i < PASSWORDS.length; i++) {
    console.log(`  ${passwordLineNumbers[i]}: ${PASSWORDS[i]} (${(PASSWORD_POSITIONS[i] * 100).toFixed(1)}%)`);
  }

  // Build the wordlist
  let passwordIndex = 0;
  for (let lineNum = 0; lineNum < totalSize; lineNum++) {
    if (passwordIndex < PASSWORDS.length && lineNum === passwordLineNumbers[passwordIndex]) {
      finalWordlist.push(PASSWORDS[passwordIndex]);
      passwordIndex++;
    } else {
      finalWordlist.push(fillerArray[fillerIndex]);
      fillerIndex++;
    }
  }

  // Write the wordlist
  const outputPath = resolve(__dirname, "smoke-wordlist.txt");
  writeFileSync(outputPath, finalWordlist.join("\n") + "\n");

  console.log(`\nWordlist written to: ${outputPath}`);
  console.log(`Total words: ${finalWordlist.length}`);
  console.log(`Keyspace with 561 rules: ${finalWordlist.length * 561} (~${(finalWordlist.length * 561 / 1000000).toFixed(1)}M)`);

  // Verify passwords are in correct positions
  console.log("\nVerifying password positions...");
  for (let i = 0; i < PASSWORDS.length; i++) {
    const actualLine = finalWordlist.indexOf(PASSWORDS[i]);
    const expectedLine = passwordLineNumbers[i];
    if (actualLine === expectedLine) {
      console.log(`  ✓ ${PASSWORDS[i]} at line ${actualLine}`);
    } else {
      console.log(`  ✗ ${PASSWORDS[i]} expected at ${expectedLine}, found at ${actualLine}`);
    }
  }
}

main();
