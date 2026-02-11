#!/usr/bin/env bun
/**
 * DiamondAnalyzer.ts - Analyze Cracked Passwords to Extract Actionable Feedback
 *
 * v2.3 - 2026-02-10: Added HIBP frequency checking for root prioritization.
 *   Roots with HIBP count >= 1000 are included in BETA.txt regardless of local frequency.
 * v2.2 - 2026-02-10: Promoted korean-romanized + portuguese-brazilian to COHORT_PATTERNS.
 *   Fixed double-call bug in growExistingCohorts (was called in both main and generateCohortReport).
 * REFACTORED 2026-02-09: Complete rewrite based on THEALGORITHM analysis.
 *
 * Previous approach FAILED because:
 * - Stripped suffixes from ALL passwords including random brute-force garbage
 * - nocap.txt baseline (6.4M words) swallowed almost every real root
 * - Produced noise like "lbvf", "c3bf" instead of actionable roots
 * - Could not distinguish structured passwords from random strings
 *
 * New approach:
 * 1. SEPARATE structured passwords from random/brute-force using entropy scoring
 * 2. EXTRACT roots only from structured passwords (word+suffix pattern)
 * 3. CLASSIFY new roots by cohort (names, cultural terms, compound words)
 * 4. PRODUCE actionable BETA.txt with real words + cohort analysis report
 * 5. GENERATE UNOBTAINIUM.rule from suffix/transformation patterns
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { createReadStream, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// HIBP frequency threshold: roots with this many HIBP occurrences are included
// in BETA.txt regardless of local batch frequency
const HIBP_HIGH_THRESHOLD = 1000;
const HIBP_MEDIUM_THRESHOLD = 100;
const HIBP_BATCH_SIZE = 20; // Max concurrent HIBP queries

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const OUTPUT_DIR = resolve(DATA_DIR, "processed");

// =============================================================================
// Configuration
// =============================================================================

// nocap.txt (rockyou + rizzyou) as baseline — roots IN this are already covered
const NOCAP_PATH = resolve(DATA_DIR, "nocap.txt");
const ROCKYOU_PATH = resolve(DATA_DIR, "rockyou.txt");

// Entropy threshold: passwords above this are likely random/brute-force
// "p@ssw0rd1" ≈ 2.5 bits/char, "!0tUA6" ≈ 4.5 bits/char
const ENTROPY_THRESHOLD = 3.8;

// Minimum root length for extraction
const MIN_ROOT_LENGTH = 3;

// =============================================================================
// Cohort Detection Patterns
// =============================================================================

// Language/cultural patterns for classifying roots not in baseline
const COHORT_PATTERNS: Record<string, { description: string; patterns: RegExp[]; examples: string[] }> = {
  "turkish": {
    description: "Turkish names and words",
    patterns: [
      /^(oguz|elif|yekta|furkan|emre|burak|berkay|arda|kaan|onur|cem|tolga|baris|serkan|melis|defne|cansu|dilara|gamze|pinar|zeynep|selin|irem|buse|ece|ebru|murat|kemal|ahmet|mehmet|mustafa|yusuf|hakan|volkan|erdem|tugba|deniz|ayse|fatma|hatice|kubra)$/i,
    ],
    examples: ["furkan", "emre", "berkay", "elif", "zeynep"],
  },
  "indian": {
    description: "Indian/South Asian names and words",
    patterns: [
      /^(abhi|anuj|anup|arif|ashu|amit|anil|arun|ashok|deepak|gaurav|kapil|manoj|nitin|pankaj|rahul|rajesh|sanjay|sunil|vijay|vinod|ravi|sonu|guddu|pappu|tinku|rinku|vishal|sachin|rohit|vikas|akash|sunny|neha|pooja|priya|swati|divya|sneha|anjali|komal|nisha|manish|subhash|umesh|vimal|dhaval|nishu|harsh|kiran|jyoti|meena|rekha|geeta|seema|shubham|tushar|kunal|varun|arjun|vikram|naveen|dinesh|suresh|mukesh|ramesh|ganesh|mahesh|yogesh|hitesh|ritesh|jitesh|nilesh|naresh|lokesh|rakesh|rajesh|mangesh|kamlesh)$/i,
      /^(sri|shri|ram|jai|om|dev|lal|das)$/i,
    ],
    examples: ["umesh", "subhash", "dhaval", "nishu", "vimal"],
  },
  "arabic": {
    description: "Arabic/Middle Eastern names",
    patterns: [
      /^(ahmed|ali|hassan|hussein|khalid|mahmoud|mohamed|omar|youssef|zaid|bilal|faisal|hamza|nabil|rami|sami|tarek|walid|umer|ehab|afroz|kareem|jameel|rashid|saleem|shahid|tariq|wasim|zaheer|imran|irfan|nadeem|nasir|asif|arif|junaid|fahad|sultan|nasser|abdullah|jannat|fatima|aisha|zainab|maryam|abdel|abdal|abdur|abdu)$/i,
      /^(abu[a-z]{3,})$/i,  // abu- prefix with real name (abubakar, etc.)
    ],
    examples: ["abdullah", "jannat", "ahmed", "hamza", "bilal"],
  },
  "slavic": {
    description: "Slavic/Eastern European names (diminutives)",
    patterns: [
      /^(nastya|slavik|slava|vanya|ruslan|dima|misha|kolya|petya|sasha|maks|olia|olya|natasha|katya|tanya|lena|vera|svetlana|irina|marina|elena|galina|nadia|lyuba|andrei|sergei|dmitri|nikita|artem|roman|maxim|ivan|pavel|oleg|igor|vitaly|bogdan|yaroslav|taras|sveta|zhenya|lyosha|kostya|alyona|polina|ksenia|dasha|masha|anya|yulia|tolik|zhenya|volodya|grisha|pasha|borya|gosha|senya|fedya|mitya|vasya|tolya|lyonya|lyuda)$/i,
    ],
    examples: ["nastya", "slavik", "vanya", "ruslan", "dima"],
  },
  "chinese-pinyin": {
    description: "Chinese romanized (Pinyin) names",
    patterns: [
      /^(wang|zhang|zhao|zhou|chen|yang|huang|liu|sun|xiao|lin|lei|hui|yan|fang|hong|ming|jing|wei|qiang|yong|guang|ping|cheng|dong|feng|hao|jian|jun|long|qing|shan|tao|ting|xin|zhi|zhong|bao|cai|chang|chun|gang|guo|hai|han|hua|jie|kai|lan|liang|mei|nan|ning|peng|rong|rui|sheng|shu|song|wen|wu|xia|xue|yi|ying|yu|yuan|yue|zhe|zhen|zhu|bin|bo|chao|da|fan|guang|he|heng|ji|jin|ke|kang|li|lian|luo|meng|min|mo|mu|nian|pan|qi|qin|ren|si|tan|wan|xiang|xiu|xu|yao|ye|yin|yun|zeng|zhan|zheng|zi)$/i,
    ],
    examples: ["xiao", "zhou", "ming", "jing", "wei"],
  },
  "cricket": {
    description: "Cricket players, IPL teams, fan terms",
    patterns: [
      /^(virat|kohli|bumrah|pant|dhoni|sachin|rohit|jadeja|ashwin|rahane|shami|siraj|pandya|iyer|gill|csk|rcb|mi|kkr|srh|dc|pbks|rr|lsg|gt|thala|hitman|bleedblue|whistlepodu)$/i,
    ],
    examples: ["virat", "kohli", "dhoni", "csk", "rcb"],
  },
  "kpop-music": {
    description: "K-pop, current music artists, fandoms",
    patterns: [
      /^(jungkook|jimin|yoongi|namjoon|seokjin|hoseok|taehyung|jisoo|jennie|rose|lisa|yeji|bangtan|ateez|enhypen|newjeans|aespa|sza|badbunny|dualipa|postmalone|arianagrande|harrystyles|erastour|swiftie|belieber|directioner|arianator|beyhive|blink|army|stay|engene)$/i,
    ],
    examples: ["jungkook", "jimin", "bangtan", "sza", "badbunny"],
  },
  "gaming-streaming": {
    description: "Gaming, streaming, esports terms",
    patterns: [
      /^(minecraft|fortnite|roblox|valorant|genshin|overwatch|skyrim|pokemon|zelda|warzone|apex|pubg|twitch|pewdiepie|mrbeast|among|amogus|creeper|enderman|warden|steve|herobrine|noob|ggwp)$/i,
    ],
    examples: ["minecraft", "fortnite", "overwatch", "skyrim", "valorant"],
  },
  "sports-current": {
    description: "Current sports stars and fan culture",
    patterns: [
      /^(jokic|embiid|wembanyama|banchero|kuminga|foden|haaland|mbappe|vinicius|bellingham|mahomes|stroud|bryce|lamar|burrow|dubnation|lakernation|chiefskingdom|billsmafia)$/i,
    ],
    examples: ["jokic", "embiid", "wembanyama", "mahomes"],
  },
  "streetwear-culture": {
    description: "Streetwear brands, hype culture",
    patterns: [
      /^(bape|yeezy|vlone|fog|rhude|supreme|offwhite|stockx|goat|grailed|hypebeast|deadstock|sneakers)$/i,
    ],
    examples: ["bape", "yeezy", "vlone", "supreme"],
  },
  "korean-romanized": {
    description: "Korean romanized names (surnames + given names)",
    patterns: [
      /^(kim|lee|park|choi|jung|kang|cho|yoon|jang|lim|han|shin|seo|kwon|hwang|ahn|song|jeon|moon|bae|baek|nam|noh|ryu|yoo|cha|hong|ko|woo|byun|goo|heo|uhm|chung|minjun|seonho|jiwon|seojin|dohyun|hajin|yejun|siwoo|jihoon|jaemin|jinho|taehyun|eunwoo|hyunjin|sunwoo|gunwoo|yejin|soeun|chaewon|haerin|minji|haeun|seoyeon|jiyeon)$/i,
    ],
    examples: ["minjun", "jiwon", "hyunjin", "chaewon", "minji"],
  },
  "portuguese-brazilian": {
    description: "Portuguese/Brazilian names and cultural terms",
    patterns: [
      /^(joao|thiago|mateus|rafael|felipe|gabriel|gustavo|henrique|leandro|marcelo|flavio|caio|vitor|renan|danilo|fabio|renato|bruna|fernanda|juliana|larissa|leticia|camila|beatriz|luana|raquel|priscila|aline|monique|thaisa|neymar|ronaldinho|rivaldo|kaka|robinho|adriano|saudade|futebol|capoeira|carnaval|samba|bossa|coxinha|brigadeiro|acai)$/i,
      /^.*(inho|inha|zinho|zinha)$/i,
    ],
    examples: ["joao", "thiago", "neymar", "saudade", "capoeira"],
  },
  "spanish-phrases": {
    description: "Spanish/Latin American names, phrases, and cultural terms",
    patterns: [
      // Names — male
      /^(alejandro|santiago|mateo|camilo|andres|sergio|javier|fernando|raul|pablo|rodrigo|carlos|diego|enrique|hector|jorge|luis|manuel|miguel|oscar|pedro|ricardo|roberto|eduardo|francisco|gerardo|gilberto|guillermo|ignacio|joaquin|jose|juan|leonel|lorenzo|marcos|mario|mauricio|nestor|orlando|ramon|rafael|salvador|sebastian|tomas|vicente|victor|xavier)$/i,
      // Names — female
      /^(adriana|valentina|catalina|mariana|natalia|daniela|ximena|paola|lorena|rocio|marisol|guadalupe|esperanza|alejandra|andrea|beatriz|camila|carmen|cecilia|claudia|elena|esperanza|fernanda|gabriela|graciela|isabella|jimena|juliana|leticia|lucia|luisa|marcela|mercedes|monica|patricia|pilar|regina|renata|rosario|sandra|silvia|sofia|susana|teresa|veronica|viviana|yolanda)$/i,
      // Romantic/emotional terms
      /^(amor|teamo|tequiero|corazon|cariño|princesa|hermosa|bonita|linda|preciosa|querida|amorcito|dulce|pasion|beso|abrazo|novio|novia|amore|miamor|teadoro|tekiero)$/i,
      // Cultural/slang
      /^(vamos|chingon|cabron|puta|madre|mierda|verga|pendejo|guey|loco|loca|chido|neta|orale|andale|arriba|fiesta|cerveza|tequila|mariachi|sombrero|amigo|compadre|hermano|familia|barrio|guerrero|patron|jefe)$/i,
      // Football/sports
      /^(realmadrid|barcelona|americafc|chivas|boca|river|pumas|tigres|santos|messi|maradona|neymar|ronaldo|futbol|gol)$/i,
      // Music/reggaeton
      /^(badbunny|jbalvin|daddy|yankee|ozuna|maluma|shakira|reggaeton|perreo|dembow|regueton)$/i,
    ],
    examples: ["alejandro", "teamo", "corazon", "vamos", "chingon"],
  },
  "french-phrases": {
    description: "French names, phrases, and cultural terms",
    patterns: [
      // Names — male
      /^(jean|pierre|jacques|philippe|nicolas|franck|stephane|christophe|baptiste|guillaume|mathieu|cedric|antoine|benoit|charles|damien|edouard|fabien|gabriel|henri|julien|laurent|marc|olivier|pascal|quentin|romain|sebastien|thierry|thomas|vincent|xavier|yannick|alain|andre|bernard|claude|denis|emile|francois|gerard|hugues|ivan|jerome|kevin|louis|maxime|noel|patrice|raymond|serge|sylvain)$/i,
      // Names — female
      /^(nathalie|sylvie|valerie|aurelie|virginie|clemence|amelie|brigitte|camille|delphine|elodie|florence|gisele|helene|isabelle|joelle|karine|laetitia|marie|nadine|oceane|pauline|rachel|sophie|therese|veronique|celine|corinne|dominique|estelle|genevieve|juliette|lucienne|marguerite|monique|mireille|sandrine|stephanie|chloe|manon|lea|jade|emma|louise|alice|ines|lina|eva|charlotte|anna)$/i,
      // Romantic/emotional terms
      /^(amour|jetaime|bonjour|bisou|cherie|doudou|coucou|chouchou|loulou|bebe|monamour|coeur|tresor|mignon|calin|tendresse|passion|desir|reve|ange|jolie|belle|magnifique|merveilleux)$/i,
      // Cultural terms
      /^(soleil|marseille|paris|lyon|toulouse|bordeaux|nantes|strasbourg|montpellier|azerty|motdepasse|liberte|egalite|fraternite|fromage|champagne|baguette|croissant|chateau|jardin|fleur|etoile|papillon|lumiere)$/i,
      // Profanity/slang
      /^(merde|putain|bordel|connard|salaud|enfoitre|foutre|nique|batard|casse|degage|fiche|zut|sacrebleu)$/i,
      // Football
      /^(olympiquemarseille|psg|parissaintgermain|equipedefrance|zidane|mbappe|griezmann|benzema|platini|ribery|pogba|cantona)$/i,
    ],
    examples: ["jetaime", "bonjour", "doudou", "soleil", "marseille"],
  },
  "compound-word": {
    description: "Compound words (two dictionary words joined)",
    patterns: [
      // Detected via length + recognizable sub-patterns
      /^[a-z]{4,}[a-z]{4,}$/i, // Will be filtered further by isCompoundWord()
    ],
    examples: ["dragonmaster", "strangerthings", "leagueoflegends"],
  },
};

// =============================================================================
// Discovery Patterns — Languages/Themes NOT Yet in COHORT_PATTERNS
// =============================================================================
//
// These are fingerprints for detecting potential NEW cohorts in unclassified
// roots. When enough unclassified roots match a discovery pattern, it's
// surfaced in the cohort report as a "Potential New Cohort" for human review.
//
// Once validated, a discovery pattern graduates to COHORT_PATTERNS above
// and gets a dedicated wordlist file in data/cohorts/.

const DISCOVERY_PATTERNS: Record<string, { description: string; patterns: RegExp[]; minMatches: number }> = {
  // korean-romanized: GRADUATED to COHORT_PATTERNS (batch-0006)
  // portuguese-brazilian: GRADUATED to COHORT_PATTERNS (batch-0006)
  // spanish-latam: GRADUATED to COHORT_PATTERNS as "spanish-phrases" (batch-0008 prep, 2026-02-11)
  // french: GRADUATED to COHORT_PATTERNS as "french-phrases" (batch-0008 prep, 2026-02-11)
  "japanese-romanized": {
    description: "Japanese romanized names and words",
    patterns: [
      /^(hiroshi|takeshi|yuki|kenji|satoshi|haruki|akira|daiki|kaito|ren|yuto|sota|haruto|minato|riku|aoi|sakura|hana|mei|yui|mio|rin|sora|miku|kento|shota|ryota|naoki|yusuke|daisuke|takuya|shunsuke|kazuki)$/i,
      /^(naruto|sasuke|kakashi|itachi|goku|vegeta|ichigo|luffy|zoro|levi|eren|todoroki|deku|gojo|sukuna|tanjiro|nezuko|pikachu|charizard|gengar|snorlax)$/i,
    ],
    minMatches: 3,
  },
  // spanish-latam: GRADUATED (see above)
  // french: GRADUATED (see above)
  "thai-romanized": {
    description: "Thai romanized names",
    patterns: [
      /^(somchai|somsak|somporn|wichai|piyapong|nattapong|thanat|siriporn|supaporn|siriwan|wannee)$/i,
      /^.*(porn|chai|kul|wut|sak|pon|wit|pong|phon|sri|siri)$/i,
    ],
    minMatches: 3,
  },
  "vietnamese": {
    description: "Vietnamese names (romanized)",
    patterns: [
      /^(nguyen|tran|pham|hoang|phan|huong|dang|bui|duong|dinh|minh|anh|linh|dung|hieu|tuan|thanh|trung|quang|hung|phong|thinh|khoa|tien|cuong|duc|vinh|hai|long|nam|bao|nhat|khanh)$/i,
    ],
    minMatches: 3,
  },
  "filipino": {
    description: "Filipino names and words",
    patterns: [
      /^(jhun|jeric|jayson|marlon|rodel|arnel|aldrin|jennylyn|angeline|precious|divine|princess|jhoan|jonalyn|maricris|maricel|marites|rodalyn|maryjane|jomari|ronaldo|reynaldo|rizalino)$/i,
    ],
    minMatches: 3,
  },
  "anime-manga": {
    description: "Anime/manga/Japanese pop culture",
    patterns: [
      /^(onepiece|dragonball|jujutsu|demonslayer|attackontitan|myheroacademia|deathnode|tokyoghoul|hunterxhunter|bleach|cowboy|samurai|shinobi|rasengan|kamehameha|sharingan|bankai|chakra|senpai|waifu|kawaii|sugoi|baka|otaku|weeb|neko|chan|sama|sensei|shonen|seinen|isekai)$/i,
    ],
    minMatches: 3,
  },
  "german": {
    description: "German names and words",
    patterns: [
      /^(hans|fritz|karl|ludwig|friedrich|heinrich|wolfgang|helmut|dieter|gunther|manfred|rainer|bernd|uwe|jorg|steffen|thorsten|matthias|florian|stefan|katrin|heike|monika|sabine|petra|andrea|birgit|ingrid)$/i,
      /^(schatz|liebe|stern|engel|blume|freund|herz|traum|nacht|feuer|donner|blitz)$/i,
    ],
    minMatches: 3,
  },
};

interface CohortDiscovery {
  pattern: string;
  description: string;
  matchedRoots: { root: string; count: number; examples: string[] }[];
}

// =============================================================================
// Types
// =============================================================================

interface StructuredPassword {
  original: string;
  root: string;
  suffix: string;
  prefix: string;
  isStructured: boolean;
  entropy: number;
}

interface CohortMatch {
  root: string;
  cohort: string;
  count: number;
  examples: string[]; // passwords containing this root
}

interface AnalysisResult {
  totalPasswords: number;
  uniquePasswords: number;
  structuredCount: number;
  randomCount: number;
  roots: Map<string, { count: number; examples: string[] }>;
  newRoots: Map<string, { count: number; examples: string[]; cohorts: string[] }>;
  cohortMatches: Map<string, CohortMatch[]>;
  suffixes: Map<string, number>;
  patterns: Map<string, number>;
  lengthDistribution: Map<number, number>;
}

// =============================================================================
// Entropy & Structure Detection
// =============================================================================

/**
 * Calculate Shannon entropy per character.
 * Random strings: ~4.0-5.0 bits/char
 * Structured passwords: ~2.0-3.5 bits/char
 */
function entropyPerChar(password: string): number {
  if (password.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const c of password) {
    freq.set(c, (freq.get(c) || 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / password.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Determine if a password has structure (word-based) vs random.
 * Structured: "minecraft1234", "Abdullah@456", "nastya2023"
 * Random: "!0tUA6", "c3bf", "7eknr2rq"
 */
function classifyPassword(password: string): StructuredPassword {
  const entropy = entropyPerChar(password);

  // Extract potential root by removing suffix digits/specials and prefix digits
  let prefix = "";
  let suffix = "";
  let root = password;

  // Strip leading digits
  const prefixMatch = root.match(/^(\d+)(.*)/);
  if (prefixMatch) {
    prefix = prefixMatch[1];
    root = prefixMatch[2];
  }

  // Strip trailing digits
  const digitSuffix = root.match(/^(.*?)(\d+)$/);
  if (digitSuffix) {
    root = digitSuffix[1];
    suffix = digitSuffix[2];
  }

  // Strip trailing specials
  const specialSuffix = root.match(/^(.*?)([!@#$%^&*()_\-+=.]+)$/);
  if (specialSuffix) {
    root = specialSuffix[1];
    suffix = specialSuffix[2] + suffix;
  }

  root = root.toLowerCase();

  // Structured password criteria:
  // 1. Root is at least 3 chars of ONLY letters
  // 2. Root itself must look word-like (low entropy, consonant-vowel patterns)
  // 3. Short random roots (3-4 char) with high entropy are NOT structured
  const hasLetterRoot = root.length >= MIN_ROOT_LENGTH && /^[a-z]+$/i.test(root);
  const isLowEntropy = entropy < ENTROPY_THRESHOLD;
  const hasSuffix = suffix.length > 0 || prefix.length > 0;

  // Check if root looks like a real word (has vowels, not all consonants)
  const hasVowels = /[aeiouy]/i.test(root);
  const vowelRatio = (root.match(/[aeiouy]/gi) || []).length / root.length;

  // Root entropy — "minecraft" has low root entropy, "xfr" has high
  const rootEntropy = entropyPerChar(root);

  // A password is structured if:
  // - Has a letter root with vowels (real words have vowels)
  // - Root is either long enough (5+) to be a word, OR has low root entropy
  // - Short roots (3-4 chars) must have good vowel ratio to avoid "xfr", "eii", "cdf"
  const isLongRoot = root.length >= 5;
  const isShortButWordLike = root.length >= 3 && root.length <= 4 && vowelRatio >= 0.25 && rootEntropy < 2.5;
  const isStructured = hasLetterRoot && hasVowels && (isLongRoot || isShortButWordLike);

  return { original: password, root, suffix, prefix, isStructured, entropy };
}

// =============================================================================
// Baseline Loading
// =============================================================================

/**
 * Load baseline as a Set of lowercased words for O(1) lookup.
 * We store the RAW words (not extracted roots) because we want to check
 * if the root word itself exists as a password/word in the baseline.
 */
async function loadBaseline(): Promise<Set<string>> {
  const words = new Set<string>();

  const baselinePath = existsSync(NOCAP_PATH) ? NOCAP_PATH : ROCKYOU_PATH;
  if (!existsSync(baselinePath)) {
    console.warn("No baseline wordlist found");
    return words;
  }

  console.log(`Loading baseline from: ${baselinePath}`);

  const rl = createInterface({
    input: createReadStream(baselinePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.length >= MIN_ROOT_LENGTH) {
      words.add(line.toLowerCase().trim());
    }
  }

  console.log(`  Loaded ${words.size.toLocaleString()} baseline words`);
  return words;
}

// =============================================================================
// Cohort Classification
// =============================================================================

/**
 * Classify a root word into cohort(s) based on pattern matching.
 */
function classifyCohort(root: string): string[] {
  const matches: string[] = [];
  for (const [name, cohort] of Object.entries(COHORT_PATTERNS)) {
    if (name === "compound-word") continue; // handled separately
    for (const pattern of cohort.patterns) {
      if (pattern.test(root)) {
        matches.push(name);
        break;
      }
    }
  }
  return matches;
}

// =============================================================================
// Analysis Engine
// =============================================================================

/**
 * Analyze DIAMOND passwords — the core refactored logic.
 */
async function analyzePasswords(inputPath: string): Promise<AnalysisResult> {
  const result: AnalysisResult = {
    totalPasswords: 0,
    uniquePasswords: 0,
    structuredCount: 0,
    randomCount: 0,
    roots: new Map(),
    newRoots: new Map(),
    cohortMatches: new Map(),
    suffixes: new Map(),
    patterns: new Map(),
    lengthDistribution: new Map(),
  };

  const seen = new Set<string>();

  const rl = createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    result.totalPasswords++;

    // Handle HASH:PASSWORD format
    const password = line.includes(":") ? line.split(":").slice(1).join(":") : line;
    if (!password || password.startsWith("$HEX[")) continue;

    // Dedup
    if (seen.has(password)) continue;
    seen.add(password);
    result.uniquePasswords++;

    // Length distribution
    result.lengthDistribution.set(password.length, (result.lengthDistribution.get(password.length) || 0) + 1);

    // Classify: structured vs random
    const classified = classifyPassword(password);

    if (classified.isStructured) {
      result.structuredCount++;

      // Track root
      const existing = result.roots.get(classified.root);
      if (existing) {
        existing.count++;
        if (existing.examples.length < 5) existing.examples.push(password);
      } else {
        result.roots.set(classified.root, { count: 1, examples: [password] });
      }

      // Track suffix patterns
      if (classified.suffix) {
        result.suffixes.set(classified.suffix, (result.suffixes.get(classified.suffix) || 0) + 1);
      }
    } else {
      result.randomCount++;
    }

    // Detect transformation patterns (on all passwords)
    if (/^[A-Z][a-z]/.test(password)) result.patterns.set("capitalize", (result.patterns.get("capitalize") || 0) + 1);
    if (/\d+$/.test(password)) {
      const dLen = password.match(/(\d+)$/)![1].length;
      result.patterns.set(`suffix:d${dLen}`, (result.patterns.get(`suffix:d${dLen}`) || 0) + 1);
    }
    if (/[!@#$%^&*()]/.test(password)) result.patterns.set("has-special", (result.patterns.get("has-special") || 0) + 1);
    const yearMatch = password.match(/(20[12]\d)$/);
    if (yearMatch) result.patterns.set(`suffix:year:${yearMatch[1]}`, (result.patterns.get(`suffix:year:${yearMatch[1]}`) || 0) + 1);
  }

  return result;
}

/**
 * Find roots that are NOT in the baseline wordlist.
 * These are the genuinely new discoveries.
 */
function findNewRoots(
  roots: Map<string, { count: number; examples: string[] }>,
  baseline: Set<string>
): Map<string, { count: number; examples: string[]; cohorts: string[] }> {
  const newRoots = new Map<string, { count: number; examples: string[]; cohorts: string[] }>();

  for (const [root, data] of roots) {
    // Skip if root exists as a word in baseline
    if (baseline.has(root)) continue;

    // Also skip very short roots that are likely noise
    if (root.length < 3) continue;

    // Skip if it looks like a keyboard pattern or common fragment
    if (/^(qwer|asdf|zxcv|abcd|pass|word|test|admin|user|login|1234)/.test(root)) continue;

    // Classify into cohorts
    const cohorts = classifyCohort(root);

    newRoots.set(root, { ...data, cohorts });
  }

  return newRoots;
}

/**
 * Group new roots by cohort for actionable reporting.
 */
function buildCohortReport(
  newRoots: Map<string, { count: number; examples: string[]; cohorts: string[] }>
): Map<string, CohortMatch[]> {
  const report = new Map<string, CohortMatch[]>();

  // Initialize all cohorts
  for (const name of Object.keys(COHORT_PATTERNS)) {
    report.set(name, []);
  }
  report.set("unclassified", []);

  for (const [root, data] of newRoots) {
    if (data.cohorts.length === 0) {
      // Unclassified — still valuable, just not matched to a known cohort
      report.get("unclassified")!.push({
        root,
        cohort: "unclassified",
        count: data.count,
        examples: data.examples,
      });
    } else {
      for (const cohort of data.cohorts) {
        report.get(cohort)!.push({
          root,
          cohort,
          count: data.count,
          examples: data.examples,
        });
      }
    }
  }

  return report;
}

// =============================================================================
// New Cohort Discovery
// =============================================================================

/**
 * Scan unclassified roots for patterns matching DISCOVERY_PATTERNS.
 * Returns potential new cohorts with enough evidence to warrant investigation.
 */
function discoverNewCohorts(
  unclassified: CohortMatch[]
): CohortDiscovery[] {
  const discoveries: CohortDiscovery[] = [];

  for (const [name, fingerprint] of Object.entries(DISCOVERY_PATTERNS)) {
    const matched: { root: string; count: number; examples: string[] }[] = [];

    for (const item of unclassified) {
      for (const pattern of fingerprint.patterns) {
        if (pattern.test(item.root)) {
          matched.push({ root: item.root, count: item.count, examples: item.examples });
          break;
        }
      }
    }

    if (matched.length >= fingerprint.minMatches) {
      discoveries.push({
        pattern: name,
        description: fingerprint.description,
        matchedRoots: matched.sort((a, b) => b.count - a.count),
      });
    }
  }

  return discoveries.sort((a, b) => b.matchedRoots.length - a.matchedRoots.length);
}

// =============================================================================
// Existing Cohort Growth — Add New Members to Cohort Wordlists
// =============================================================================

// Map cohort pattern names → cohort wordlist filenames in data/cohorts/
const COHORT_FILE_MAP: Record<string, string> = {
  "turkish": "turkish-names.txt",
  "indian": "indian-names.txt",
  "arabic": "arabic-names.txt",
  "slavic": "slavic-names.txt",
  "chinese-pinyin": "chinese-pinyin.txt",
  "korean-romanized": "korean-romanized.txt",
  "portuguese-brazilian": "portuguese-brazilian.txt",
  "cricket": "culture-sports-music.txt",
  "kpop-music": "culture-sports-music.txt",
  "gaming-streaming": "culture-sports-music.txt",
  "sports-current": "culture-sports-music.txt",
  "streetwear-culture": "culture-sports-music.txt",
};

/**
 * Load all words from a cohort wordlist file into a Set.
 */
function loadCohortFile(filename: string): Set<string> {
  const cohortPath = resolve(DATA_DIR, "cohorts", filename);
  const words = new Set<string>();
  if (!existsSync(cohortPath)) return words;
  const content = readFileSync(cohortPath, "utf-8");
  for (const line of content.split("\n")) {
    const word = line.trim().toLowerCase();
    if (word && !word.startsWith("#")) words.add(word);
  }
  return words;
}

interface CohortGrowthResult {
  cohort: string;
  file: string;
  newMembers: string[];
}

/**
 * Find cohort-matched roots that aren't already in their cohort wordlist file.
 * Appends new members to the file and returns what was added.
 */
function growExistingCohorts(
  cohortReport: Map<string, CohortMatch[]>
): CohortGrowthResult[] {
  const results: CohortGrowthResult[] = [];

  // Cache loaded files (multiple cohorts may share a file)
  const fileCache = new Map<string, Set<string>>();

  for (const [cohortName, matches] of cohortReport) {
    if (cohortName === "unclassified" || cohortName === "compound-word") continue;
    if (matches.length === 0) continue;

    const filename = COHORT_FILE_MAP[cohortName];
    if (!filename) continue;

    // Load the file (cached)
    if (!fileCache.has(filename)) {
      fileCache.set(filename, loadCohortFile(filename));
    }
    const existing = fileCache.get(filename)!;

    const newMembers: string[] = [];
    for (const match of matches) {
      const root = match.root.toLowerCase();
      if (!existing.has(root)) {
        newMembers.push(root);
        existing.add(root); // prevent duplicates across cohorts sharing a file
      }
    }

    if (newMembers.length > 0) {
      // Append to file
      const cohortPath = resolve(DATA_DIR, "cohorts", filename);
      if (existsSync(cohortPath)) {
        appendFileSync(cohortPath, newMembers.join("\n") + "\n");
      }
      results.push({ cohort: cohortName, file: filename, newMembers });
    }
  }

  return results;
}

// =============================================================================
// Output Generation
// =============================================================================

/**
 * Query HIBP Pwned Passwords API (k-anonymity) for a single password/root.
 * Returns the breach count (how many times this exact string appears in HIBP).
 * Uses SHA-1 prefix (5 chars) to preserve k-anonymity.
 */
async function queryHIBP(word: string): Promise<number> {
  const sha1 = createHash("sha1").update(word).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "User-Agent": "PAI-DiamondAnalyzer" },
    });
    if (!resp.ok) return 0;
    const text = await resp.text();
    for (const line of text.split("\n")) {
      const [hash, count] = line.trim().split(":");
      if (hash === suffix) return parseInt(count) || 0;
    }
  } catch {
    // Network error — silently return 0
  }
  return 0;
}

/**
 * Batch-query HIBP for multiple roots. Returns Map<root, hibpCount>.
 * Rate-limits to HIBP_BATCH_SIZE concurrent requests to be respectful.
 */
async function batchQueryHIBP(roots: string[]): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  for (let i = 0; i < roots.length; i += HIBP_BATCH_SIZE) {
    const batch = roots.slice(i, i + HIBP_BATCH_SIZE);
    const promises = batch.map(async (root) => {
      const count = await queryHIBP(root);
      results.set(root, count);
    });
    await Promise.all(promises);
    // Small delay between batches to be respectful to HIBP API
    if (i + HIBP_BATCH_SIZE < roots.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return results;
}

/**
 * Generate BETA.txt — ACTIONABLE new root words for password cracking.
 *
 * CRITICAL DESIGN DECISION: BETA.txt must be HIGH-SIGNAL, not exhaustive.
 * A 50K-entry BETA.txt full of noise is WORSE than a 200-entry BETA.txt
 * of real words, because hashcat will waste GPU time on garbage.
 *
 * Inclusion criteria:
 * 1. Cohort-matched roots — ALWAYS included (these are real names/words)
 * 2. Unclassified roots — ONLY if freq >= 3 AND length >= 5
 *    (high frequency across different passwords = likely real word, not noise)
 * 3. HIBP-validated roots — If HIBP breach count >= 1000, include regardless
 *    of local frequency (proves the root is globally common as a password)
 * 3. Cohort wordlists — the bulk of BETA.txt comes from GENERATED cohort
 *    wordlists (Turkish names, Indian names, etc.), NOT from diamond extraction
 */
async function generateBeta(
  newRoots: Map<string, { count: number; examples: string[]; cohorts: string[] }>,
  outputPath: string
): Promise<{ count: number; hibpPromoted: string[] }> {
  const betaRoots: string[] = [];
  const hibpPromoted: string[] = [];

  // Phase 1: Include cohort-matched and high-frequency roots (existing logic)
  const candidatesForHIBP: string[] = [];

  for (const [root, data] of newRoots) {
    if (data.cohorts.length > 0) {
      // Cohort-matched: always include
      betaRoots.push(root);
    } else if (data.count >= 3 && root.length >= 5) {
      // Unclassified but high-frequency + long enough to be a real word
      betaRoots.push(root);
    } else if (root.length >= 4) {
      // Candidate for HIBP validation — not yet included but worth checking
      candidatesForHIBP.push(root);
    }
  }

  // Phase 2: HIBP frequency validation for borderline roots
  // Only check roots not already included, limit to reasonable batch size
  if (candidatesForHIBP.length > 0) {
    // Prioritize: longer roots and higher local frequency first
    candidatesForHIBP.sort((a, b) => {
      const aData = newRoots.get(a)!;
      const bData = newRoots.get(b)!;
      // Sort by local frequency desc, then length desc
      if (bData.count !== aData.count) return bData.count - aData.count;
      return b.length - a.length;
    });

    // Cap at 200 HIBP queries to be respectful to the API
    const toCheck = candidatesForHIBP.slice(0, 200);
    console.log(`  Checking ${toCheck.length} candidate roots against HIBP...`);

    const hibpResults = await batchQueryHIBP(toCheck);

    for (const [root, hibpCount] of hibpResults) {
      if (hibpCount >= HIBP_HIGH_THRESHOLD) {
        betaRoots.push(root);
        hibpPromoted.push(root);
        const data = newRoots.get(root)!;
        console.log(`    HIBP promoted: ${root} (${hibpCount.toLocaleString()} breaches, ${data.count}x local)`);
      }
    }

    if (hibpPromoted.length === 0) {
      console.log(`    No roots met HIBP threshold (>=${HIBP_HIGH_THRESHOLD.toLocaleString()} breaches)`);
    }
  }

  // Sort: cohort-matched first, then HIBP-promoted, then by local frequency
  const betaSet = new Set(betaRoots);
  const hibpSet = new Set(hibpPromoted);
  betaRoots.sort((a, b) => {
    const aData = newRoots.get(a)!;
    const bData = newRoots.get(b)!;
    const aHasCohort = aData.cohorts.length > 0 ? 1 : 0;
    const bHasCohort = bData.cohorts.length > 0 ? 1 : 0;
    if (bHasCohort !== aHasCohort) return bHasCohort - aHasCohort;
    const aHibp = hibpSet.has(a) ? 1 : 0;
    const bHibp = hibpSet.has(b) ? 1 : 0;
    if (bHibp !== aHibp) return bHibp - aHibp;
    return bData.count - aData.count;
  });

  writeFileSync(outputPath, betaRoots.join("\n") + "\n");
  return { count: betaRoots.length, hibpPromoted };
}

/**
 * Generate UNOBTAINIUM.rule — suffix/transformation rules from DIAMONDS.
 */
function generateUnobtainium(
  suffixes: Map<string, number>,
  patterns: Map<string, number>,
  outputPath: string
): number {
  const rules = new Set<string>();

  // Generate append rules from top suffixes
  const sortedSuffixes = Array.from(suffixes.entries())
    .filter(([_, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100);

  for (const [suffix] of sortedSuffixes) {
    const rule = suffix.split("").map(c => `$${c}`).join(" ");
    rules.add(rule);
  }

  // Year suffix rules (2015-2026)
  for (let year = 2015; year <= 2026; year++) {
    rules.add(`$${String(year)[0]} $${String(year)[1]} $${String(year)[2]} $${String(year)[3]}`);
  }

  // Common transformation combos from patterns
  if ((patterns.get("capitalize") || 0) > 10) {
    rules.add("c");
    rules.add("c $1");
    rules.add("c $1 $2 $3");
  }

  const ruleArray = Array.from(rules);

  const header = [
    "# UNOBTAINIUM.rule - Auto-generated from DIAMOND analysis",
    "# PURPOSE: Suffix/transformation rules discovered from cracked passwords.",
    `# Generated: ${new Date().toISOString()}`,
    `# Rules: ${ruleArray.length}`,
    "",
  ];

  writeFileSync(outputPath, header.join("\n") + ruleArray.join("\n") + "\n");
  return ruleArray.length;
}

/**
 * Generate cohort analysis report (Markdown).
 */
function generateCohortReport(
  result: AnalysisResult,
  cohortReport: Map<string, CohortMatch[]>,
  growthResults: CohortGrowthResult[],
  outputPath: string
): void {
  const lines: string[] = [
    `# DIAMOND Analysis Report — Cohort Discovery`,
    ``,
    `**Generated:** ${new Date().toISOString()}`,
    `**Input:** ${result.totalPasswords.toLocaleString()} passwords, ${result.uniquePasswords.toLocaleString()} unique`,
    ``,
    `## Password Classification`,
    ``,
    `| Category | Count | % |`,
    `|----------|-------|---|`,
    `| Structured (word-based) | ${result.structuredCount.toLocaleString()} | ${((result.structuredCount / result.uniquePasswords) * 100).toFixed(1)}% |`,
    `| Random/brute-force | ${result.randomCount.toLocaleString()} | ${((result.randomCount / result.uniquePasswords) * 100).toFixed(1)}% |`,
    `| **Unique roots extracted** | **${result.roots.size.toLocaleString()}** | |`,
    `| **New roots (not in baseline)** | **${result.newRoots.size.toLocaleString()}** | |`,
    ``,
    `## Cohort Discovery`,
    ``,
    `New roots NOT in nocap.txt, classified by category:`,
    ``,
  ];

  // Separate actionable cohorts from unclassified noise
  const actionableCohorts = Array.from(cohortReport.entries())
    .filter(([name, matches]) => name !== "unclassified" && matches.length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  const unclassified = cohortReport.get("unclassified") || [];

  // Show actionable cohorts first
  for (const [cohort, matches] of actionableCohorts) {
    const desc = COHORT_PATTERNS[cohort]?.description || cohort;
    lines.push(`### ${cohort} — ${desc} (${matches.length} new roots)`);
    lines.push(``);

    const sorted = matches.sort((a, b) => b.count - a.count);
    for (const match of sorted.slice(0, 30)) {
      const exStr = match.examples.slice(0, 3).join(", ");
      lines.push(`- **${match.root}** (${match.count}x) — e.g. ${exStr}`);
    }
    if (sorted.length > 30) {
      lines.push(`- ... and ${sorted.length - 30} more`);
    }
    lines.push(``);
  }

  // Show unclassified separately — these are NOT in BETA.txt unless freq >= 3 AND len >= 5
  if (unclassified.length > 0) {
    const highConf = unclassified.filter(m => m.count >= 3 && m.root.length >= 5);
    const noise = unclassified.length - highConf.length;

    lines.push(`### Unclassified (${unclassified.length} total, ${highConf.length} in BETA.txt, ${noise} filtered as noise)`);
    lines.push(``);
    lines.push(`Only unclassified roots with **frequency >= 3** and **length >= 5** are included in BETA.txt.`);
    lines.push(``);

    if (highConf.length > 0) {
      lines.push(`**High-confidence unclassified (included in BETA.txt):**`);
      const sorted = highConf.sort((a, b) => b.count - a.count);
      for (const match of sorted.slice(0, 20)) {
        const exStr = match.examples.slice(0, 3).join(", ");
        lines.push(`- **${match.root}** (${match.count}x) — e.g. ${exStr}`);
      }
      if (sorted.length > 20) {
        lines.push(`- ... and ${sorted.length - 20} more`);
      }
    }
    lines.push(``);
  }

  // Use actionableCohorts for the rest of the report
  const sortedCohorts = actionableCohorts;

  // ── NEW COHORT DISCOVERY ──────────────────────────────────────────────
  // Scan unclassified roots for patterns suggesting undiscovered cohorts
  const discoveries = discoverNewCohorts(unclassified);
  if (discoveries.length > 0) {
    lines.push(`## Potential New Cohorts`);
    lines.push(``);
    lines.push(`Unclassified roots matching discovery fingerprints for language/culture groups **not yet** in COHORT_PATTERNS.`);
    lines.push(`Review these and create a dedicated wordlist in \`data/cohorts/\` if the cohort is valuable.`);
    lines.push(``);

    for (const disc of discoveries) {
      const rootList = disc.matchedRoots.map(r => r.root).join(", ");
      lines.push(`### ${disc.pattern} — ${disc.description} (${disc.matchedRoots.length} matches)`);
      lines.push(``);
      for (const r of disc.matchedRoots.slice(0, 20)) {
        const exStr = r.examples.slice(0, 3).join(", ");
        lines.push(`- **${r.root}** (${r.count}x) — e.g. ${exStr}`);
      }
      if (disc.matchedRoots.length > 20) {
        lines.push(`- ... and ${disc.matchedRoots.length - 20} more`);
      }
      lines.push(``);
      lines.push(`**Action:** Research full ${disc.description} list, build \`data/cohorts/${disc.pattern}.txt\`, promote to COHORT_PATTERNS.`);
      lines.push(``);
    }
  }

  // ── EXISTING COHORT GROWTH ──────────────────────────────────────────
  // Report growth results (passed in from main, not re-run here to avoid double-append)
  if (growthResults.length > 0) {
    lines.push(`## Cohort Growth — New Members Added`);
    lines.push(``);
    lines.push(`Roots matching existing cohort patterns that were **not already** in the cohort wordlist file.`);
    lines.push(`These have been auto-appended to the corresponding file in \`data/cohorts/\`.`);
    lines.push(``);
    lines.push(`| Cohort | File | New Members | Words |`);
    lines.push(`|--------|------|-------------|-------|`);
    for (const g of growthResults) {
      lines.push(`| ${g.cohort} | \`${g.file}\` | ${g.newMembers.length} | ${g.newMembers.join(", ")} |`);
    }
    lines.push(``);
    const totalAdded = growthResults.reduce((sum, g) => sum + g.newMembers.length, 0);
    lines.push(`**Total new members added:** ${totalAdded}`);
    lines.push(``);
  }

  // Top suffix patterns
  lines.push(`## Top Suffix Patterns`);
  lines.push(``);
  lines.push(`| Suffix | Count |`);
  lines.push(`|--------|-------|`);
  const topSuffixes = Array.from(result.suffixes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  for (const [suffix, count] of topSuffixes) {
    lines.push(`| \`${suffix}\` | ${count.toLocaleString()} |`);
  }
  lines.push(``);

  // Actionable recommendations
  lines.push(`## Actionable Recommendations`);
  lines.push(``);
  for (const [cohort, matches] of sortedCohorts) {
    if (cohort === "unclassified" || matches.length < 2) continue;
    const desc = COHORT_PATTERNS[cohort]?.description || cohort;
    lines.push(`- **${cohort}**: Found ${matches.length} roots. Build a ${desc} wordlist (estimated 500-5000 entries).`);
  }
  if (discoveries.length > 0) {
    lines.push(``);
    lines.push(`**New cohort candidates** (from discovery fingerprints):`);
    for (const disc of discoveries) {
      lines.push(`- **${disc.pattern}**: ${disc.matchedRoots.length} matches found. Research and build \`data/cohorts/${disc.pattern}.txt\`.`);
    }
  }
  lines.push(``);

  writeFileSync(outputPath, lines.join("\n"));
}

// =============================================================================
// CLI
// =============================================================================

function printHelp(): void {
  console.log(`
DiamondAnalyzer v2.1 - Cohort-Based Password Analysis

REFACTORED: Separates structured passwords from random brute-force noise,
classifies new roots by cultural/linguistic cohort, produces actionable output.

Usage:
  bun DiamondAnalyzer.ts --analyze <file>   Analyze and show summary
  bun DiamondAnalyzer.ts --beta <file>      Generate BETA.txt (new roots)
  bun DiamondAnalyzer.ts --rules <file>     Generate UNOBTAINIUM.rule
  bun DiamondAnalyzer.ts --full <file>      Full analysis + all outputs

Input Format:
  Plain passwords (one per line) or HASH:PASSWORD format

Output Files:
  data/processed/BETA.txt              New root words (structured, not in baseline)
  data/processed/UNOBTAINIUM.rule      Suffix/transformation rules
  data/processed/cohort-report.md      Cohort analysis with recommendations
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printHelp();
    return;
  }

  const analyzeIdx = args.indexOf("--analyze");
  const betaIdx = args.indexOf("--beta");
  const rulesIdx = args.indexOf("--rules");
  const fullIdx = args.indexOf("--full");

  let inputFile: string | undefined;
  if (analyzeIdx !== -1) inputFile = args[analyzeIdx + 1];
  if (betaIdx !== -1) inputFile = args[betaIdx + 1];
  if (rulesIdx !== -1) inputFile = args[rulesIdx + 1];
  if (fullIdx !== -1) inputFile = args[fullIdx + 1];

  if (!inputFile || !existsSync(inputFile)) {
    console.error(`Input file not found: ${inputFile}`);
    process.exit(1);
  }

  // Ensure output directory
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`DiamondAnalyzer v2.1 — Cohort-Based Analysis`);
  console.log(`${"=".repeat(60)}\n`);
  console.log(`Input: ${inputFile}\n`);

  // Step 1: Analyze passwords
  console.log("Step 1: Classifying passwords (structured vs random)...");
  const result = await analyzePasswords(inputFile);

  console.log(`  Total: ${result.totalPasswords.toLocaleString()}`);
  console.log(`  Unique: ${result.uniquePasswords.toLocaleString()}`);
  console.log(`  Structured: ${result.structuredCount.toLocaleString()} (${((result.structuredCount / result.uniquePasswords) * 100).toFixed(1)}%)`);
  console.log(`  Random: ${result.randomCount.toLocaleString()} (${((result.randomCount / result.uniquePasswords) * 100).toFixed(1)}%)`);
  console.log(`  Unique roots: ${result.roots.size.toLocaleString()}`);

  // Step 2: Load baseline and find new roots
  console.log("\nStep 2: Comparing roots against baseline...");
  const baseline = await loadBaseline();
  result.newRoots = findNewRoots(result.roots, baseline);
  console.log(`  New roots (not in baseline): ${result.newRoots.size.toLocaleString()}`);

  // Step 3: Classify into cohorts
  console.log("\nStep 3: Classifying new roots into cohorts...");
  const cohortReport = buildCohortReport(result.newRoots);
  result.cohortMatches = cohortReport;

  for (const [cohort, matches] of cohortReport) {
    if (matches.length > 0) {
      const desc = COHORT_PATTERNS[cohort]?.description || "Unclassified";
      const topRoots = matches.slice(0, 5).map(m => m.root).join(", ");
      console.log(`  ${cohort} (${matches.length}): ${topRoots}`);
    }
  }

  // Step 3b: Discover potential new cohorts from unclassified roots
  const unclassified = cohortReport.get("unclassified") || [];
  if (unclassified.length > 0) {
    console.log(`\nStep 3b: Scanning ${unclassified.length} unclassified roots for new cohort patterns...`);
    const discoveries = discoverNewCohorts(unclassified);
    if (discoveries.length > 0) {
      for (const disc of discoveries) {
        const topRoots = disc.matchedRoots.slice(0, 5).map(r => r.root).join(", ");
        console.log(`  POTENTIAL NEW COHORT: ${disc.pattern} (${disc.matchedRoots.length} matches) — ${topRoots}`);
      }
    } else {
      console.log(`  No new cohort patterns detected`);
    }
  }

  // Step 3c: Grow existing cohort wordlists with new members
  console.log("\nStep 3c: Growing existing cohort wordlists...");
  const growthResults = growExistingCohorts(cohortReport);
  if (growthResults.length > 0) {
    for (const g of growthResults) {
      console.log(`  ${g.cohort} → +${g.newMembers.length} new members to ${g.file}: ${g.newMembers.join(", ")}`);
    }
    const totalAdded = growthResults.reduce((sum, g) => sum + g.newMembers.length, 0);
    console.log(`  Total: ${totalAdded} new members added to cohort wordlists`);
  } else {
    console.log(`  No new members to add (all cohort-matched roots already in wordlists)`);
  }

  // Show top roots by frequency
  console.log("\nTop 20 new roots by frequency:");
  const topNew = Array.from(result.newRoots.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20);
  for (const [root, data] of topNew) {
    const cohortStr = data.cohorts.length > 0 ? ` [${data.cohorts.join(", ")}]` : "";
    console.log(`  ${root} (${data.count}x)${cohortStr} — ${data.examples.slice(0, 2).join(", ")}`);
  }

  // Step 4: Generate outputs
  if (betaIdx !== -1 || fullIdx !== -1) {
    console.log("\nStep 4a: Generating BETA.txt...");
    const betaPath = resolve(OUTPUT_DIR, "BETA.txt");
    const betaResult = await generateBeta(result.newRoots, betaPath);
    console.log(`  Generated: ${betaResult.count} new root words`);
    if (betaResult.hibpPromoted.length > 0) {
      console.log(`  HIBP-promoted: ${betaResult.hibpPromoted.length} roots (>=${HIBP_HIGH_THRESHOLD.toLocaleString()} breaches)`);
    }
    console.log(`  Saved to: ${betaPath}`);
  }

  if (rulesIdx !== -1 || fullIdx !== -1) {
    console.log("\nStep 4b: Generating UNOBTAINIUM.rule...");
    const rulePath = resolve(OUTPUT_DIR, "UNOBTAINIUM.rule");
    const ruleCount = generateUnobtainium(result.suffixes, result.patterns, rulePath);
    console.log(`  Generated: ${ruleCount} rules`);
    console.log(`  Saved to: ${rulePath}`);
  }

  if (fullIdx !== -1) {
    console.log("\nStep 4c: Generating cohort report...");
    const reportPath = resolve(OUTPUT_DIR, "cohort-report.md");
    generateCohortReport(result, cohortReport, growthResults, reportPath);
    console.log(`  Saved to: ${reportPath}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("Analysis complete.");
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(console.error);
