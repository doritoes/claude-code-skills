#!/usr/bin/env bun
/**
 * HibpValidator.ts - Validate passwords against HIBP Pwned Passwords API
 *
 * Uses k-anonymity model: sends first 5 chars of SHA-1, gets matching suffixes
 * Returns breach count for each password
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { createHash } from "crypto";

interface HibpResult {
  password: string;
  count: number;
  sha1: string;
}

async function checkHibp(password: string): Promise<HibpResult> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.substring(0, 5);
  const suffix = sha1.substring(5);

  const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: {
      "User-Agent": "PAI-ExpandedPasswordList-Validator",
    },
  });

  if (!response.ok) {
    throw new Error(`HIBP API error: ${response.status}`);
  }

  const text = await response.text();
  const lines = text.split("\r\n");

  for (const line of lines) {
    const [hashSuffix, countStr] = line.split(":");
    if (hashSuffix === suffix) {
      return { password, count: parseInt(countStr, 10), sha1 };
    }
  }

  return { password, count: 0, sha1 };
}

async function checkRockyou(password: string): Promise<boolean> {
  // Check if password exists in rockyou.txt using exact match
  const proc = Bun.spawn(["grep", "-c", `^${password}$`, "C:/Users/sethh/AI-Projects/rockyou.txt"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const count = parseInt(output.trim(), 10);
  return count > 0;
}

async function validateTerms(terms: string[], minCount: number = 1000): Promise<void> {
  console.log(`\n🔍 Validating ${terms.length} terms against HIBP (min: ${minCount} breaches)...\n`);

  const results: HibpResult[] = [];
  const inRockyou: string[] = [];
  const belowThreshold: HibpResult[] = [];
  const valid: HibpResult[] = [];

  for (const term of terms) {
    // Rate limit: 1 request per 100ms to be nice to HIBP
    await new Promise((r) => setTimeout(r, 150));

    try {
      const result = await checkHibp(term);
      results.push(result);

      // Check rockyou
      const existsInRockyou = await checkRockyou(term);

      if (existsInRockyou) {
        inRockyou.push(term);
        console.log(`❌ ${term}: IN ROCKYOU (skip)`);
      } else if (result.count < minCount) {
        belowThreshold.push(result);
        console.log(`⚠️  ${term}: ${result.count.toLocaleString()} (below threshold)`);
      } else {
        valid.push(result);
        console.log(`✅ ${term}: ${result.count.toLocaleString()} breaches`);
      }
    } catch (error) {
      console.error(`❌ ${term}: Error - ${error}`);
    }
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`VALIDATION SUMMARY`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Total tested:     ${terms.length}`);
  console.log(`Valid (≥${minCount}):    ${valid.length}`);
  console.log(`Below threshold:  ${belowThreshold.length}`);
  console.log(`In rockyou:       ${inRockyou.length}`);

  if (valid.length > 0) {
    console.log(`\n✅ VALID TERMS (sorted by breach count):`);
    valid.sort((a, b) => b.count - a.count);
    for (const r of valid) {
      console.log(`   ${r.password}: ${r.count.toLocaleString()}`);
    }
  }

  if (belowThreshold.length > 0) {
    console.log(`\n⚠️  BELOW THRESHOLD (consider lowering if valuable):`);
    belowThreshold.sort((a, b) => b.count - a.count);
    for (const r of belowThreshold.slice(0, 10)) {
      console.log(`   ${r.password}: ${r.count.toLocaleString()}`);
    }
  }

  if (inRockyou.length > 0) {
    console.log(`\n❌ ALREADY IN ROCKYOU (excluded):`);
    console.log(`   ${inRockyou.join(", ")}`);
  }
}

// Candidate terms to test - organized by category
const candidateTerms: Record<string, string[]> = {
  // GAMING - Expand based on minecraft's 1.8M success
  gaming_expansion: [
    "amongus",      // Among Us (2020) - viral
    "terraria",     // 2011 sandbox
    "skyrim",       // 2011 RPG classic
    "gtav",         // GTA V (2013)
    "gtaonline",    // GTA Online
    "warzone",      // Call of Duty Warzone (2020)
    "coldwar",      // COD Cold War
    "cyberpunk",    // Cyberpunk 2077
    "eldenring",    // Elden Ring (2022)
    "darksouls",    // Dark Souls series
    "zelda",        // Already classic but check
    "botw",         // Breath of the Wild
    "animalcrossing", // Animal Crossing NH (2020)
    "stardew",      // Stardew Valley (2016)
    "hollow",       // Hollow Knight
    "hollowknight", // Hollow Knight
    "deadbydaylight", // Dead by Daylight
    "dbd",          // DBD abbreviation
    "seaofthieves", // Sea of Thieves
    "destiny",      // Destiny 2
    "destiny2",     // Destiny 2
    "ffxiv",        // Final Fantasy XIV
    "finalfantasy", // Final Fantasy
    "maplestory",   // MapleStory
    "palworld",     // Palworld (2024)
    "lethalcompany", // Lethal Company (2023)
    "hogwarts",     // Hogwarts Legacy
    "baldursgate",  // Baldur's Gate 3
  ],

  // STREAMERS - pewdiepie hit 129K, find more
  streamers_expansion: [
    "ninja",        // Ninja (Tyler Blevins)
    "ludwig",       // Ludwig
    "amouranth",    // Amouranth
    "hasan",        // HasanAbi (check vs hasanabi)
    "nickmercs",    // NICKMERCS
    "timthetatman", // TimTheTatman
    "drlupo",       // DrLupo
    "sykkuno",      // Sykkuno
    "lilypichu",    // LilyPichu
    "disguisedtoast", // Disguised Toast
    "corpse",       // Corpse Husband
    "dream",        // Dream (Minecraft)
    "georgenotfound", // GeorgeNotFound
    "sapnap",       // Sapnap
    "wilbur",       // Wilbur Soot
    "philza",       // Ph1LzA
    "quackity",     // Quackity
    "tubbo",        // Tubbo
    "ranboo",       // Ranboo
    "eret",         // Eret
    "adinross",     // Adin Ross
    "iShowSpeed",   // IShowSpeed
    "ishowspeed",   // lowercase
    "kai",          // Kai Cenat
    "kaicenat",     // Kai Cenat
  ],

  // K-POP - jungkook hit 182K, complete member names
  kpop_expansion: [
    "taehyung",     // V (BTS)
    "yoongi",       // Suga (BTS)
    "hoseok",       // J-Hope full name
    "jennie",       // BLACKPINK
    "lisa",         // BLACKPINK (check if generic)
    "rose",         // BLACKPINK (check if generic)
    "rosie",        // BLACKPINK nickname
    "twice",        // TWICE
    "nayeon",       // TWICE
    "momo",         // TWICE
    "sana",         // TWICE
    "dahyun",       // TWICE
    "itzy",         // ITZY
    "ateez",        // ATEEZ
    "seventeen",    // SEVENTEEN (check if number)
    "nctu",         // NCT U
    "nct127",       // NCT 127
    "redvelvet",    // Red Velvet
    "newjeans",     // NewJeans
    "ive",          // IVE
    "wonyoung",     // Wonyoung
    "yujin",        // Yujin
    "gidle",        // (G)I-DLE
    "kep1er",       // Kep1er
    "leeknow",      // Lee Know (Stray Kids)
    "hyunjin",      // Hyunjin (Stray Kids)
    "felix",        // Felix (Stray Kids) - check if generic
    "bangchan",     // Bang Chan (Stray Kids)
  ],

  // ANIME - Need actual character names
  anime_expansion: [
    "naruto",       // Classic but check
    "sasuke",       // Naruto
    "hinata",       // Naruto/Haikyuu
    "kakashi",      // Naruto
    "luffy",        // One Piece
    "zoro",         // One Piece
    "deku",         // My Hero Academia
    "bakugo",       // My Hero Academia
    "todoroki",     // My Hero Academia
    "allmight",     // My Hero Academia
    "levi",         // Attack on Titan
    "mikasa",       // Attack on Titan
    "armin",        // Attack on Titan
    "zenitsu",      // Demon Slayer
    "inosuke",      // Demon Slayer
    "shinobu",      // Demon Slayer
    "sukuna",       // Jujutsu Kaisen
    "megumi",       // Jujutsu Kaisen
    "itadori",      // Jujutsu Kaisen
    "nobara",       // Jujutsu Kaisen
    "chainsaw",     // Chainsaw Man
    "denji",        // Chainsaw Man
    "makima",       // Chainsaw Man
    "power",        // Chainsaw Man (check if generic)
    "spyxfamily",   // Spy x Family
    "anya",         // Spy x Family
    "loid",         // Spy x Family
    "bocchi",       // Bocchi the Rock
    "frieren",      // Frieren (2023)
  ],

  // SPORTS - Post-2009 stars
  sports_expansion: [
    "messi",        // Lionel Messi
    "ronaldo",      // Cristiano Ronaldo (check)
    "neymar",       // Neymar
    "haaland",      // Erling Haaland
    "lebron",       // LeBron James
    "curry",        // Stephen Curry (check if generic)
    "mahomes",      // Patrick Mahomes
    "brady",        // Tom Brady (check)
    "djokovic",     // Novak Djokovic
    "federer",      // Roger Federer
    "serena",       // Serena Williams (check)
    "ohtani",       // Shohei Ohtani
    "lamar",        // Lamar Jackson
    "giannis",      // Giannis Antetokounmpo
    "luka",         // Luka Doncic (check)
    "zion",         // Zion Williamson
  ],

  // MOVIES/TV - Streaming era hits
  movies_tv_expansion: [
    "witcher",      // The Witcher
    "geralt",       // Geralt (Witcher)
    "mandalorian",  // The Mandalorian (check - EU existed)
    "wanda",        // Wanda (check - common name)
    "loki",         // Loki (check - Norse)
    "thor",         // Thor (check - Norse)
    "spiderman",    // Spider-Man
    "moonknight",   // Moon Knight
    "shuri",        // Black Panther
    "nakia",        // Black Panther
    "okoye",        // Black Panther
    "wednesday",    // Wednesday Addams (check)
    "enola",        // Enola Holmes
    "eleven",       // Stranger Things (check - number)
    "hopper",       // Stranger Things (check)
    "dustin",       // Stranger Things (check - name)
    "maeve",        // The Boys (check)
    "homelander",   // The Boys
    "starlight",    // The Boys
    "euphoria",     // Euphoria
    "arcane",       // Arcane (League)
    "jinx",         // Arcane (check)
    "vi",           // Arcane (too short?)
    "sauron",       // Rings of Power (check - LOTR)
    "galadriel",    // Rings of Power (check)
    "casa",         // Money Heist
    "tokio",        // Money Heist
    "berlin",       // Money Heist
    "professor",    // Money Heist (check - generic)
  ],

  // MUSIC - More 2010s-2020s artists
  music_expansion: [
    "arianagrande", // Ariana Grande
    "ariana",       // Ariana (check)
    "taylorswift",  // Taylor Swift
    "swiftie",      // Taylor Swift fan
    "weeknd",       // The Weeknd
    "theweeknd",    // The Weeknd
    "travisscott",  // Travis Scott
    "travis",       // Travis (check - common name)
    "drake",        // Drake (check)
    "kendrick",     // Kendrick Lamar
    "kanye",        // Kanye West
    "yeezus",       // Kanye nickname
    "yeezy",        // Yeezy brand
    "cardi",        // Cardi B
    "cardib",       // Cardi B
    "dababy",       // DaBaby
    "lizzo",        // Lizzo
    "harrystyles",  // Harry Styles
    "onedirection", // One Direction (check)
    "shawnmendes",  // Shawn Mendes
    "justinbieber", // Justin Bieber
    "bieber",       // Bieber (check)
    "selenagomez",  // Selena Gomez
    "bts",          // Already have
    "blackpink",    // Already have? Check
    "adele",        // Adele (check - name)
    "ed",           // Ed Sheeran (too short)
    "edsheeran",    // Ed Sheeran
    "bruno",        // Bruno Mars (check)
    "brunomars",    // Bruno Mars
    "sza",          // SZA
    "tylerthecreator", // Tyler the Creator
  ],

  // NEW CATEGORY: Tech/Apps
  tech_apps: [
    "tiktok",       // TikTok (check - already tested?)
    "discord",      // Discord (check - pre-2009 meaning)
    "twitch",       // Twitch
    "youtube",      // YouTube (check)
    "roblox",       // Roblox (check)
    "steam",        // Steam (check)
    "epic",         // Epic Games (check - generic)
    "epicgames",    // Epic Games
    "nvidia",       // NVIDIA
    "amd",          // AMD (too short?)
    "playstation",  // PlayStation (check)
    "ps4",          // PS4
    "ps5",          // PS5
    "xbox",         // Xbox (check)
    "switch",       // Nintendo Switch (check - generic)
    "gamepass",     // Xbox Game Pass
    "prime",        // Amazon Prime (check - generic)
    "amazonprime",  // Amazon Prime
    "roku",         // Roku
    "peacock",      // Peacock (check)
    "paramount",    // Paramount+ (check)
    "crunchyroll",  // Crunchyroll
    "vrify",        // VR apps
    "oculus",       // Oculus
    "meta",         // Meta (check - generic)
    "quest",        // Quest VR (check - generic)
    "zuckerberg",   // Mark Zuckerberg
    "elonmusk",     // Elon Musk
    "elon",         // Elon (check)
    "starlink",     // Starlink
    "cybertruck",   // Cybertruck
    "tesla",        // Tesla (check)
    "spacex",       // SpaceX
    "neuralink",    // Neuralink
  ],

  // NEW CATEGORY: Memes/Internet Culture 2.0
  memes_expansion: [
    "rickroll",     // Rickroll
    "harambe",      // Harambe (2016)
    "pepe",         // Pepe (check)
    "wojak",        // Wojak meme
    "chad",         // Chad meme (check - name)
    "karen",        // Karen meme (check - name)
    "boomer",       // Boomer meme (check)
    "zoomer",       // Zoomer meme
    "gamer",        // Gamer (check)
    "weeb",         // Weeb
    "waifu",        // Waifu
    "poggers",      // Twitch emote
    "kekw",         // Twitch emote
    "monkas",       // Twitch emote
    "pepega",       // Twitch emote
    "copium",       // Copium meme
    "hopium",       // Hopium meme
    "ratio",        // Ratio (Twitter meme)
    "skull",        // Skull emoji meme (check - generic)
    "devious",      // Devious lick (check)
    "griddy",       // Griddy dance
    "rizzler",      // Rizz meme
    "ohio",         // Ohio memes (check)
    "sigma",        // Sigma grindset (check - Greek)
    "sigmamale",    // Sigma male
    "gigachad",     // Gigachad
    "soyboy",       // Soy boy
    "npc",          // NPC meme
  ],
};

// Run validation
const allTerms = Object.values(candidateTerms).flat();
console.log(`\n📊 HIBP VALIDATION FOR RIZZYOU.TXT EXPANSION`);
console.log(`${"=".repeat(60)}`);
console.log(`Categories: ${Object.keys(candidateTerms).length}`);
console.log(`Total candidates: ${allTerms.length}`);
console.log(`Threshold: 1,000+ breaches`);
console.log(`${"=".repeat(60)}`);

// Process in batches by category
for (const [category, terms] of Object.entries(candidateTerms)) {
  console.log(`\n\n📁 CATEGORY: ${category.toUpperCase()}`);
  console.log(`${"─".repeat(50)}`);
  await validateTerms(terms, 1000);
}
