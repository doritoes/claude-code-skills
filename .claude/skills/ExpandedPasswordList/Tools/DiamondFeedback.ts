#!/usr/bin/env bun
/**
 * DiamondFeedback.ts - Analyze DIAMONDS to Extract Feedback for Next Batch
 *
 * Merged from DiamondAnalyzer + DiamondFeedback (2026-02-23):
 * - Single tool replaces both DiamondAnalyzer and old DiamondFeedback
 * - Entropy-based classification, cohort pattern matching, HIBP validation
 * - Produces BETA.txt, unobtainium.rule, feedback-report.json, cohort-report.md
 *
 * Modes:
 *   --batch batch-NNNN          Standard post-batch feedback (fast, no network)
 *   --batch batch-NNNN --full   Full analysis with HIBP + cohort growth + report
 *   --analyze <file>            Analyze a standalone password file
 *   --dry-run                   Preview without writing files
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// =============================================================================
// Configuration
// =============================================================================

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const DIAMONDS_DIR = resolve(DATA_DIR, "diamonds");
const FEEDBACK_DIR = resolve(DATA_DIR, "feedback");

// Thresholds
const MIN_ROOT_LENGTH = 3;
const MIN_ROOT_FREQUENCY = 2;
const MIN_PATTERN_FREQUENCY = 5;
const MIN_SUFFIX_FREQUENCY = 3;
const ENTROPY_THRESHOLD = 3.8;

// HIBP configuration (only used with --full)
const HIBP_HIGH_THRESHOLD = 1000;
const HIBP_BATCH_SIZE = 20;

// Baseline wordlists
const NOCAP_PATH = resolve(DATA_DIR, "nocap.txt");
const ROCKYOU_PATH = resolve(DATA_DIR, "rockyou.txt");

// Cohort wordlists directory
const COHORTS_DIR = resolve(DATA_DIR, "cohorts");

// Persistent discovered roots — accumulates across ALL batches
const DISCOVERED_ROOTS_PATH = resolve(FEEDBACK_DIR, "discovered-roots.txt");

// Sand state for feedback metrics
const SAND_STATE_PATH = resolve(DATA_DIR, "sand-state.json");

// Baseline rule files to compare against
const ONERULE_PATH = resolve(SKILL_DIR, "..", "..", "..", "OneRuleToRuleThemStill.rule");
const NOCAP_RULE_PATH = resolve(DATA_DIR, "nocap.rule");

// =============================================================================
// Cohort Detection Patterns (from DiamondAnalyzer)
// =============================================================================

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
      /^(abu[a-z]{3,})$/i,
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
      /^(alejandro|santiago|mateo|camilo|andres|sergio|javier|fernando|raul|pablo|rodrigo|carlos|diego|enrique|hector|jorge|luis|manuel|miguel|oscar|pedro|ricardo|roberto|eduardo|francisco|gerardo|gilberto|guillermo|ignacio|joaquin|jose|juan|leonel|lorenzo|marcos|mario|mauricio|nestor|orlando|ramon|rafael|salvador|sebastian|tomas|vicente|victor|xavier)$/i,
      /^(adriana|valentina|catalina|mariana|natalia|daniela|ximena|paola|lorena|rocio|marisol|guadalupe|esperanza|alejandra|andrea|beatriz|camila|carmen|cecilia|claudia|elena|esperanza|fernanda|gabriela|graciela|isabella|jimena|juliana|leticia|lucia|luisa|marcela|mercedes|monica|patricia|pilar|regina|renata|rosario|sandra|silvia|sofia|susana|teresa|veronica|viviana|yolanda)$/i,
      /^(amor|teamo|tequiero|corazon|cariño|princesa|hermosa|bonita|linda|preciosa|querida|amorcito|dulce|pasion|beso|abrazo|novio|novia|amore|miamor|teadoro|tekiero)$/i,
      /^(vamos|chingon|cabron|puta|madre|mierda|verga|pendejo|guey|loco|loca|chido|neta|orale|andale|arriba|fiesta|cerveza|tequila|mariachi|sombrero|amigo|compadre|hermano|familia|barrio|guerrero|patron|jefe)$/i,
      /^(realmadrid|barcelona|americafc|chivas|boca|river|pumas|tigres|santos|messi|maradona|neymar|ronaldo|futbol|gol)$/i,
      /^(badbunny|jbalvin|daddy|yankee|ozuna|maluma|shakira|reggaeton|perreo|dembow|regueton)$/i,
    ],
    examples: ["alejandro", "teamo", "corazon", "vamos", "chingon"],
  },
  "french-phrases": {
    description: "French names, phrases, and cultural terms",
    patterns: [
      /^(jean|pierre|jacques|philippe|nicolas|franck|stephane|christophe|baptiste|guillaume|mathieu|cedric|antoine|benoit|charles|damien|edouard|fabien|gabriel|henri|julien|laurent|marc|olivier|pascal|quentin|romain|sebastien|thierry|thomas|vincent|xavier|yannick|alain|andre|bernard|claude|denis|emile|francois|gerard|hugues|ivan|jerome|kevin|louis|maxime|noel|patrice|raymond|serge|sylvain)$/i,
      /^(nathalie|sylvie|valerie|aurelie|virginie|clemence|amelie|brigitte|camille|delphine|elodie|florence|gisele|helene|isabelle|joelle|karine|laetitia|marie|nadine|oceane|pauline|rachel|sophie|therese|veronique|celine|corinne|dominique|estelle|genevieve|juliette|lucienne|marguerite|monique|mireille|sandrine|stephanie|chloe|manon|lea|jade|emma|louise|alice|ines|lina|eva|charlotte|anna)$/i,
      /^(amour|jetaime|bonjour|bisou|cherie|doudou|coucou|chouchou|loulou|bebe|monamour|coeur|tresor|mignon|calin|tendresse|passion|desir|reve|ange|jolie|belle|magnifique|merveilleux)$/i,
      /^(soleil|marseille|paris|lyon|toulouse|bordeaux|nantes|strasbourg|montpellier|azerty|motdepasse|liberte|egalite|fraternite|fromage|champagne|baguette|croissant|chateau|jardin|fleur|etoile|papillon|lumiere)$/i,
      /^(merde|putain|bordel|connard|salaud|enfoitre|foutre|nique|batard|casse|degage|fiche|zut|sacrebleu)$/i,
      /^(olympiquemarseille|psg|parissaintgermain|equipedefrance|zidane|mbappe|griezmann|benzema|platini|ribery|pogba|cantona)$/i,
    ],
    examples: ["jetaime", "bonjour", "doudou", "soleil", "marseille"],
  },
  "compound-word": {
    description: "Compound words (two dictionary words joined)",
    patterns: [
      /^[a-z]{4,}[a-z]{4,}$/i,
    ],
    examples: ["dragonmaster", "strangerthings", "leagueoflegends"],
  },
};

// =============================================================================
// Discovery Patterns — Languages/Themes NOT Yet in COHORT_PATTERNS
// =============================================================================

const DISCOVERY_PATTERNS: Record<string, { description: string; patterns: RegExp[]; minMatches: number }> = {
  "japanese-romanized": {
    description: "Japanese romanized names and words",
    patterns: [
      /^(hiroshi|takeshi|yuki|kenji|satoshi|haruki|akira|daiki|kaito|ren|yuto|sota|haruto|minato|riku|aoi|sakura|hana|mei|yui|mio|rin|sora|miku|kento|shota|ryota|naoki|yusuke|daisuke|takuya|shunsuke|kazuki)$/i,
      /^(naruto|sasuke|kakashi|itachi|goku|vegeta|ichigo|luffy|zoro|levi|eren|todoroki|deku|gojo|sukuna|tanjiro|nezuko|pikachu|charizard|gengar|snorlax)$/i,
    ],
    minMatches: 3,
  },
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
  examples: string[];
}

interface CohortDiscovery {
  pattern: string;
  description: string;
  matchedRoots: { root: string; count: number; examples: string[] }[];
}

interface CohortGrowthResult {
  cohort: string;
  file: string;
  newMembers: string[];
}

interface AnalysisResult {
  totalPasswords: number;
  uniquePasswords: number;
  structuredCount: number;
  randomCount: number;
  roots: Map<string, { count: number; examples: string[] }>;
  rootWords: Map<string, number>;
  newRoots: Map<string, { count: number; examples: string[]; cohorts: string[] }>;
  cohortMatches: Map<string, CohortMatch[]>;
  patterns: Map<string, number>;
  suffixes: Map<string, number>;
  prefixes: Map<string, number>;
  lengthDistribution: Map<number, number>;
  charsetDistribution: {
    lowercase: number;
    uppercase: number;
    digits: number;
    special: number;
    mixed: number;
  };
}

interface FeedbackReport {
  timestamp: string;
  batchesAnalyzed: string[];
  totalDiamonds: number;
  uniquePasswords: number;
  structuredCount: number;
  randomCount: number;
  baselineLoaded: boolean;
  baselinePath: string | null;
  baselineRootCount: number;
  baselineRulesLoaded: boolean;
  baselineRuleSources: string[];
  baselineRuleCount: number;
  totalRootsExtracted: number;
  newRoots: number;
  candidateRules: number;
  filteredRules: number;
  newRules: number;
  topNewRoots: string[];
  topPatterns: string[];
  betaPath: string;
  rulePath: string;
}

// =============================================================================
// Entropy & Structure Detection
// =============================================================================

/**
 * Calculate Shannon entropy per character.
 * Random strings: ~4.0-5.0 bits/char, Structured passwords: ~2.0-3.5 bits/char
 */
function entropyPerChar(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) || 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Classify a password as structured (word-based) vs random.
 * Returns the full classification including root, suffix, prefix, entropy.
 *
 * Structured: "minecraft1234", "Abdullah@456", "nastya2023"
 * Random: "!0tUA6", "c3bf", "7eknr2rq"
 */
function classifyPassword(password: string): StructuredPassword {
  const entropy = entropyPerChar(password);

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

  const hasLetterRoot = root.length >= MIN_ROOT_LENGTH && /^[a-z]+$/i.test(root);
  const hasVowels = /[aeiouy]/i.test(root);
  const vowelRatio = (root.match(/[aeiouy]/gi) || []).length / root.length;
  const rootEntropy = entropyPerChar(root);

  const isLongRoot = root.length >= 5;
  const isShortButWordLike = root.length >= 3 && root.length <= 4 && vowelRatio >= 0.25 && rootEntropy < 2.5;
  const isStructured = hasLetterRoot && hasVowels && (isLongRoot || isShortButWordLike);

  return { original: password, root, suffix, prefix, isStructured, entropy };
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
    if (name === "compound-word") continue;
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
// Pattern Detection
// =============================================================================

/**
 * Detect transformation patterns in password
 */
function detectPatterns(password: string): string[] {
  const detected: string[] = [];

  if (password.length <= 6) detected.push("len:short");
  else if (password.length <= 8) detected.push("len:medium");
  else if (password.length <= 12) detected.push("len:long");
  else detected.push("len:very-long");

  if (/^[A-Z][a-z]+/.test(password)) detected.push("case:capitalize");
  if (/^[A-Z]+$/.test(password)) detected.push("case:upper");
  if (/^[a-z]+$/.test(password)) detected.push("case:lower");
  if (/^[a-z]+[A-Z]/.test(password)) detected.push("case:camel");

  const digitMatch = password.match(/(\d+)$/);
  if (digitMatch) {
    const digits = digitMatch[1];
    detected.push(`suffix:d${digits.length}`);
    if (/^(19|20)\d{2}$/.test(digits)) {
      detected.push("suffix:year");
      if (/^202[0-6]$/.test(digits)) detected.push("suffix:year-recent");
    }
    if (/^123/.test(digits)) detected.push("suffix:123-seq");
    if (/^(\d)\1+$/.test(digits)) detected.push("suffix:repeated");
  }

  const specialMatch = password.match(/([!@#$%^&*()]+)$/);
  if (specialMatch) {
    const special = specialMatch[1];
    detected.push(`suffix:special`);
    if (special === "!") detected.push("suffix:!");
    if (special === "@") detected.push("suffix:@");
    if (special === "!@") detected.push("suffix:!@");
    if (special === "123") detected.push("suffix:123");
  }

  if (/\d+[!@#$%^&*()]+$/.test(password)) detected.push("suffix:digit-special");
  if (/^\d+[a-zA-Z]/.test(password)) detected.push("prefix:digits");

  if (/[4@]/.test(password) && /[a-zA-Z]/.test(password)) detected.push("leet:a");
  if (/3/.test(password) && /[eE]/.test(password)) detected.push("leet:e");
  if (/[1!]/.test(password) && /[iIlL]/.test(password)) detected.push("leet:i");
  if (/0/.test(password) && /[oO]/.test(password)) detected.push("leet:o");
  if (/\$/.test(password) && /[sS]/.test(password)) detected.push("leet:s");

  if (/qwer|asdf|zxcv/i.test(password)) detected.push("keyboard:row");
  if (/qaz|wsx|edc/i.test(password)) detected.push("keyboard:column");

  if (/(.)\1{2,}/.test(password)) detected.push("repeat:char");
  if (/(.{2,})\1+/.test(password)) detected.push("repeat:sequence");

  return detected;
}

/**
 * Convert pattern to hashcat rule
 */
function patternToRule(pattern: string, count: number): string | null {
  if (count < MIN_PATTERN_FREQUENCY) return null;

  if (pattern === "suffix:d1") return "$0";
  if (pattern === "suffix:d2") return "$0 $1";
  if (pattern === "suffix:d3") return "$1 $2 $3";
  if (pattern === "suffix:d4") return "$1 $2 $3 $4";
  if (pattern === "suffix:!") return "$!";
  if (pattern === "suffix:@") return "$@";
  if (pattern === "suffix:!@") return "$! $@";
  if (pattern === "suffix:123") return "$1 $2 $3";
  if (pattern === "suffix:123-seq") return "$1 $2 $3";
  if (pattern === "suffix:year-recent") return null;
  if (pattern === "case:capitalize") return "c";
  if (pattern === "case:upper") return "u";
  if (pattern === "case:lower") return "l";
  if (pattern === "leet:a") return "sa@";
  if (pattern === "leet:e") return "se3";
  if (pattern === "leet:i") return "si1";
  if (pattern === "leet:o") return "so0";
  if (pattern === "leet:s") return "ss$";

  return null;
}

/**
 * Generate specific suffix rules from actual data
 */
function generateSuffixRules(suffixes: Map<string, number>): string[] {
  const rules: string[] = [];
  const sorted = Array.from(suffixes.entries())
    .filter(([_, count]) => count >= MIN_SUFFIX_FREQUENCY)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100);

  for (const [suffix, _] of sorted) {
    const rule = suffix.split("").map(c => `$${c}`).join(" ");
    rules.push(rule);
  }
  return rules;
}

// =============================================================================
// File Analysis
// =============================================================================

/**
 * Analyze passwords from a file using entropy-based classification.
 */
async function analyzeFile(filePath: string): Promise<AnalysisResult> {
  const result: AnalysisResult = {
    totalPasswords: 0,
    uniquePasswords: 0,
    structuredCount: 0,
    randomCount: 0,
    roots: new Map(),
    rootWords: new Map(),
    newRoots: new Map(),
    cohortMatches: new Map(),
    patterns: new Map(),
    suffixes: new Map(),
    prefixes: new Map(),
    lengthDistribution: new Map(),
    charsetDistribution: { lowercase: 0, uppercase: 0, digits: 0, special: 0, mixed: 0 },
  };

  const seen = new Set<string>();

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    result.totalPasswords++;

    // Parse line: JSONL {"hash":"...","plain":"..."}, or plain text
    let password: string;
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line);
        password = obj.plain || "";
      } catch {
        continue;
      }
    } else {
      password = line;
    }
    if (!password) continue;

    if (seen.has(password)) continue;
    seen.add(password);
    result.uniquePasswords++;

    // Length distribution
    result.lengthDistribution.set(password.length, (result.lengthDistribution.get(password.length) || 0) + 1);

    // Charset analysis
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSpecial = /[^a-zA-Z0-9]/.test(password);

    if (hasLower && !hasUpper && !hasDigit && !hasSpecial) result.charsetDistribution.lowercase++;
    else if (!hasLower && hasUpper && !hasDigit && !hasSpecial) result.charsetDistribution.uppercase++;
    else if (!hasLower && !hasUpper && hasDigit && !hasSpecial) result.charsetDistribution.digits++;
    else if (!hasLower && !hasUpper && !hasDigit && hasSpecial) result.charsetDistribution.special++;
    else result.charsetDistribution.mixed++;

    // Classify: structured vs random
    const classified = classifyPassword(password);

    if (classified.isStructured) {
      result.structuredCount++;

      // Track root with examples (for cohort analysis)
      const existing = result.roots.get(classified.root);
      if (existing) {
        existing.count++;
        if (existing.examples.length < 5) existing.examples.push(password);
      } else {
        result.roots.set(classified.root, { count: 1, examples: [password] });
      }

      // Track root count (for basic mode)
      result.rootWords.set(classified.root, (result.rootWords.get(classified.root) || 0) + 1);

      // Track suffix patterns
      if (classified.suffix) {
        result.suffixes.set(classified.suffix, (result.suffixes.get(classified.suffix) || 0) + 1);
      }
    } else {
      result.randomCount++;
    }

    // Detect transformation patterns (on all passwords)
    const patterns = detectPatterns(password);
    for (const p of patterns) {
      result.patterns.set(p, (result.patterns.get(p) || 0) + 1);
    }

    // Track actual suffixes (from all passwords, not just structured)
    const digitSuffix = password.match(/(\d+)$/);
    if (digitSuffix) {
      result.suffixes.set(digitSuffix[1], (result.suffixes.get(digitSuffix[1]) || 0) + 1);
    }

    const specialSuffix = password.match(/([!@#$%^&*()]+)$/);
    if (specialSuffix) {
      result.suffixes.set(specialSuffix[1], (result.suffixes.get(specialSuffix[1]) || 0) + 1);
    }

    // Track prefixes
    const digitPrefix = password.match(/^(\d+)/);
    if (digitPrefix) {
      result.prefixes.set(digitPrefix[1], (result.prefixes.get(digitPrefix[1]) || 0) + 1);
    }
  }

  return result;
}

// =============================================================================
// Baseline Loading
// =============================================================================

interface BaselineResult {
  roots: Set<string>;
  loaded: boolean;
  path: string | null;
  count: number;
}

/**
 * Stream baseline wordlists and remove matching entries from the candidate set.
 * Inverted lookup: instead of loading 14M+ words into a Set, we stream the
 * baseline files and delete matches from the small (~14K) candidate set.
 * Memory: O(candidates.size) instead of O(baseline_lines).
 */
async function filterAgainstBaseline(
  candidates: Set<string>
): Promise<BaselineResult> {
  let baselinePath: string | null = null;
  if (existsSync(NOCAP_PATH)) {
    baselinePath = NOCAP_PATH;
  } else if (existsSync(ROCKYOU_PATH)) {
    baselinePath = ROCKYOU_PATH;
  }

  if (!baselinePath) {
    console.warn(`\nWARNING: No baseline wordlist found!`);
    console.warn(`  Expected: ${NOCAP_PATH}`);
    console.warn(`  Without a baseline, ALL roots will appear as "new".`);
    return { roots: new Set<string>(), loaded: false, path: null, count: 0 };
  }

  const startSize = candidates.size;
  console.log(`\nStreaming baseline filter from: ${baselinePath}`);
  console.log(`  Candidates to check: ${startSize.toLocaleString()}`);

  let linesStreamed = 0;
  const rl = createInterface({
    input: createReadStream(baselinePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.length >= MIN_ROOT_LENGTH) {
      candidates.delete(line.toLowerCase().trim());
    }
    linesStreamed++;
    if (candidates.size === 0) break; // all matched, early exit
  }

  // Also stream cohort wordlists
  if (existsSync(COHORTS_DIR)) {
    const cohortFiles = readdirSync(COHORTS_DIR).filter(f => f.endsWith(".txt"));
    for (const file of cohortFiles) {
      if (candidates.size === 0) break;
      const cohortPath = resolve(COHORTS_DIR, file);
      const rl2 = createInterface({
        input: createReadStream(cohortPath),
        crlfDelay: Infinity,
      });
      for await (const line of rl2) {
        const trimmed = line.trim().toLowerCase();
        if (trimmed && !trimmed.startsWith("#")) {
          candidates.delete(trimmed);
        }
      }
    }
  }

  const removed = startSize - candidates.size;
  console.log(`  Streamed ${linesStreamed.toLocaleString()} baseline words`);
  console.log(`  Removed ${removed.toLocaleString()} known roots, ${candidates.size.toLocaleString()} new`);
  return { roots: new Set<string>(), loaded: true, path: baselinePath, count: linesStreamed };
}

interface BaselineRulesResult {
  rules: Set<string>;
  loaded: boolean;
  sources: string[];
  count: number;
}

/**
 * Load baseline rules from OneRuleToRuleThemStill and nocap.rule
 */
async function loadBaselineRules(): Promise<BaselineRulesResult> {
  const rules = new Set<string>();
  const sources: string[] = [];

  const rulePaths = [
    { path: ONERULE_PATH, name: "OneRuleToRuleThemStill.rule" },
    { path: NOCAP_RULE_PATH, name: "nocap.rule" },
  ];

  for (const { path, name } of rulePaths) {
    if (!existsSync(path)) {
      console.log(`  Baseline rule file not found: ${name}`);
      continue;
    }

    const rl = createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    });

    let count = 0;
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const normalizedRule = trimmed.replace(/\s+/g, " ");
      rules.add(normalizedRule);
      count++;
    }

    sources.push(`${name} (${count.toLocaleString()} rules)`);
  }

  return { rules, loaded: sources.length > 0, sources, count: rules.size };
}

// =============================================================================
// New Root Discovery & Cohort Classification
// =============================================================================

/**
 * Find roots that are NOT in the baseline wordlist.
 * Streams baseline files to avoid loading 14M+ words into memory.
 * Classifies each remaining root into cohorts.
 */
async function findNewRoots(
  roots: Map<string, { count: number; examples: string[] }>
): Promise<{ newRoots: Map<string, { count: number; examples: string[]; cohorts: string[] }>; baseline: BaselineResult }> {
  // Build candidate set from root keys (small, ~14K entries)
  const candidates = new Set<string>();
  for (const [root] of roots) {
    if (root.length < 3) continue;
    if (/^(qwer|asdf|zxcv|abcd|pass|word|test|admin|user|login|1234)/.test(root)) continue;
    candidates.add(root);
  }

  // Stream baseline files and remove known words from candidates
  const baseline = await filterAgainstBaseline(candidates);

  // What remains in candidates are new roots
  const newRoots = new Map<string, { count: number; examples: string[]; cohorts: string[] }>();
  for (const root of candidates) {
    const data = roots.get(root);
    if (!data) continue;
    const cohorts = classifyCohort(root);
    newRoots.set(root, { ...data, cohorts });
  }

  return { newRoots, baseline };
}

/**
 * Group new roots by cohort for actionable reporting.
 */
function buildCohortReport(
  newRoots: Map<string, { count: number; examples: string[]; cohorts: string[] }>
): Map<string, CohortMatch[]> {
  const report = new Map<string, CohortMatch[]>();

  for (const name of Object.keys(COHORT_PATTERNS)) {
    report.set(name, []);
  }
  report.set("unclassified", []);

  for (const [root, data] of newRoots) {
    if (data.cohorts.length === 0) {
      report.get("unclassified")!.push({ root, cohort: "unclassified", count: data.count, examples: data.examples });
    } else {
      for (const cohort of data.cohorts) {
        report.get(cohort)!.push({ root, cohort, count: data.count, examples: data.examples });
      }
    }
  }

  return report;
}

/**
 * Scan unclassified roots for patterns matching DISCOVERY_PATTERNS.
 */
function discoverNewCohorts(unclassified: CohortMatch[]): CohortDiscovery[] {
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
// Existing Cohort Growth
// =============================================================================

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

/**
 * Find cohort-matched roots not already in their wordlist file.
 * Appends new members to the file.
 */
function growExistingCohorts(cohortReport: Map<string, CohortMatch[]>): CohortGrowthResult[] {
  const results: CohortGrowthResult[] = [];
  const fileCache = new Map<string, Set<string>>();

  for (const [cohortName, matches] of cohortReport) {
    if (cohortName === "unclassified" || cohortName === "compound-word") continue;
    if (matches.length === 0) continue;

    const filename = COHORT_FILE_MAP[cohortName];
    if (!filename) continue;

    if (!fileCache.has(filename)) {
      fileCache.set(filename, loadCohortFile(filename));
    }
    const existing = fileCache.get(filename)!;

    const newMembers: string[] = [];
    for (const match of matches) {
      const root = match.root.toLowerCase();
      if (!existing.has(root)) {
        newMembers.push(root);
        existing.add(root);
      }
    }

    if (newMembers.length > 0) {
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
// HIBP Querying (only used with --full)
// =============================================================================

/**
 * Query HIBP Pwned Passwords API (k-anonymity) for a single word.
 * Returns the breach count.
 */
async function queryHIBP(word: string): Promise<number> {
  const sha1 = createHash("sha1").update(word).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "User-Agent": "PAI-DiamondFeedback" },
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
    if (i + HIBP_BATCH_SIZE < roots.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return results;
}

// =============================================================================
// Cohort Report Generation (Markdown)
// =============================================================================

/**
 * Generate cohort-report.md with classification and recommendations.
 * Only called with --full flag.
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

  const actionableCohorts = Array.from(cohortReport.entries())
    .filter(([name, matches]) => name !== "unclassified" && matches.length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  const unclassified = cohortReport.get("unclassified") || [];

  for (const [cohort, matches] of actionableCohorts) {
    const desc = COHORT_PATTERNS[cohort]?.description || cohort;
    lines.push(`### ${cohort} — ${desc} (${matches.length} new roots)`);
    lines.push(``);
    const sorted = matches.sort((a, b) => b.count - a.count);
    for (const match of sorted.slice(0, 30)) {
      const exStr = match.examples.slice(0, 3).join(", ");
      lines.push(`- **${match.root}** (${match.count}x) — e.g. ${exStr}`);
    }
    if (sorted.length > 30) lines.push(`- ... and ${sorted.length - 30} more`);
    lines.push(``);
  }

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
      if (sorted.length > 20) lines.push(`- ... and ${sorted.length - 20} more`);
    }
    lines.push(``);
  }

  // New cohort discovery
  const discoveries = discoverNewCohorts(unclassified);
  if (discoveries.length > 0) {
    lines.push(`## Potential New Cohorts`);
    lines.push(``);
    lines.push(`Unclassified roots matching discovery fingerprints for language/culture groups **not yet** in COHORT_PATTERNS.`);
    lines.push(``);
    for (const disc of discoveries) {
      lines.push(`### ${disc.pattern} — ${disc.description} (${disc.matchedRoots.length} matches)`);
      lines.push(``);
      for (const r of disc.matchedRoots.slice(0, 20)) {
        const exStr = r.examples.slice(0, 3).join(", ");
        lines.push(`- **${r.root}** (${r.count}x) — e.g. ${exStr}`);
      }
      if (disc.matchedRoots.length > 20) lines.push(`- ... and ${disc.matchedRoots.length - 20} more`);
      lines.push(``);
      lines.push(`**Action:** Research full ${disc.description} list, build \`data/cohorts/${disc.pattern}.txt\`, promote to COHORT_PATTERNS.`);
      lines.push(``);
    }
  }

  // Cohort growth results
  if (growthResults.length > 0) {
    lines.push(`## Cohort Growth — New Members Added`);
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

  // Recommendations
  lines.push(`## Actionable Recommendations`);
  lines.push(``);
  for (const [cohort, matches] of actionableCohorts) {
    if (matches.length < 2) continue;
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
// Main Feedback Generation
// =============================================================================

/**
 * Analyze all DIAMONDS and generate feedback.
 */
async function generateFeedback(options: {
  batches?: string[];
  minRootFreq?: number;
  full?: boolean;
  dryRun?: boolean;
}): Promise<FeedbackReport> {
  const {
    batches,
    minRootFreq = MIN_ROOT_FREQUENCY,
    full = false,
    dryRun = false,
  } = options;

  if (!existsSync(FEEDBACK_DIR)) {
    mkdirSync(FEEDBACK_DIR, { recursive: true });
  }

  // Find DIAMOND files to analyze
  let diamondFiles: string[] = [];

  if (batches && batches.length > 0) {
    for (const batch of batches) {
      const pwPath = resolve(DIAMONDS_DIR, `passwords-${batch}.txt`);
      if (existsSync(pwPath)) {
        diamondFiles.push(pwPath);
      } else {
        console.warn(`Warning: No DIAMONDS password file for ${batch}`);
      }
    }
  } else {
    if (existsSync(DIAMONDS_DIR)) {
      diamondFiles = readdirSync(DIAMONDS_DIR)
        .filter(f => f.startsWith("passwords-batch-") && f.endsWith(".txt"))
        .map(f => resolve(DIAMONDS_DIR, f));
    }
    const jsonlPath = resolve(DIAMONDS_DIR, "hash_plaintext_pairs.jsonl");
    if (existsSync(jsonlPath) && diamondFiles.length === 0) {
      diamondFiles.push(jsonlPath);
    }
  }

  if (diamondFiles.length === 0) {
    console.error("No DIAMOND files found to analyze");
    process.exit(1);
  }

  console.log(`\nAnalyzing ${diamondFiles.length} DIAMOND file(s)...`);

  // Aggregate analysis across all files
  const aggregated: AnalysisResult = {
    totalPasswords: 0,
    uniquePasswords: 0,
    structuredCount: 0,
    randomCount: 0,
    roots: new Map(),
    rootWords: new Map(),
    newRoots: new Map(),
    cohortMatches: new Map(),
    patterns: new Map(),
    suffixes: new Map(),
    prefixes: new Map(),
    lengthDistribution: new Map(),
    charsetDistribution: { lowercase: 0, uppercase: 0, digits: 0, special: 0, mixed: 0 },
  };

  const batchesAnalyzed: string[] = [];

  for (const filePath of diamondFiles) {
    const batchName = filePath.split(/[/\\]/).pop()?.replace(".txt", "") || "unknown";
    batchesAnalyzed.push(batchName);

    console.log(`  Analyzing ${batchName}...`);
    const result = await analyzeFile(filePath);

    aggregated.totalPasswords += result.totalPasswords;
    aggregated.uniquePasswords += result.uniquePasswords;
    aggregated.structuredCount += result.structuredCount;
    aggregated.randomCount += result.randomCount;

    // Merge maps
    for (const [key, val] of result.rootWords) {
      aggregated.rootWords.set(key, (aggregated.rootWords.get(key) || 0) + val);
    }
    for (const [key, val] of result.roots) {
      const existing = aggregated.roots.get(key);
      if (existing) {
        existing.count += val.count;
        for (const ex of val.examples) {
          if (existing.examples.length < 5) existing.examples.push(ex);
        }
      } else {
        aggregated.roots.set(key, { count: val.count, examples: [...val.examples] });
      }
    }
    for (const [key, val] of result.patterns) {
      aggregated.patterns.set(key, (aggregated.patterns.get(key) || 0) + val);
    }
    for (const [key, val] of result.suffixes) {
      aggregated.suffixes.set(key, (aggregated.suffixes.get(key) || 0) + val);
    }
    for (const [key, val] of result.prefixes) {
      aggregated.prefixes.set(key, (aggregated.prefixes.get(key) || 0) + val);
    }
    for (const [key, val] of result.lengthDistribution) {
      aggregated.lengthDistribution.set(key, (aggregated.lengthDistribution.get(key) || 0) + val);
    }
    aggregated.charsetDistribution.lowercase += result.charsetDistribution.lowercase;
    aggregated.charsetDistribution.uppercase += result.charsetDistribution.uppercase;
    aggregated.charsetDistribution.digits += result.charsetDistribution.digits;
    aggregated.charsetDistribution.special += result.charsetDistribution.special;
    aggregated.charsetDistribution.mixed += result.charsetDistribution.mixed;
  }

  console.log(`\nTotal passwords analyzed: ${aggregated.totalPasswords.toLocaleString()}`);
  console.log(`Unique passwords: ${aggregated.uniquePasswords.toLocaleString()}`);
  console.log(`Structured: ${aggregated.structuredCount.toLocaleString()} (${((aggregated.structuredCount / aggregated.uniquePasswords) * 100).toFixed(1)}%)`);
  console.log(`Random: ${aggregated.randomCount.toLocaleString()} (${((aggregated.randomCount / aggregated.uniquePasswords) * 100).toFixed(1)}%)`);
  console.log(`Unique roots: ${aggregated.roots.size.toLocaleString()}`);

  // Find NEW roots (streams baseline — no bulk memory load)
  const { newRoots: discoveredNewRoots, baseline } = await findNewRoots(aggregated.roots);
  aggregated.newRoots = discoveredNewRoots;

  // Apply frequency filter for basic new root list
  const newRoots: Array<{ root: string; count: number }> = [];
  for (const [root, data] of aggregated.newRoots) {
    if (data.count >= minRootFreq) {
      if (root.length >= 5 || data.count >= 5) {
        newRoots.push({ root, count: data.count });
      }
    }
  }
  newRoots.sort((a, b) => b.count - a.count);

  console.log(`\nTotal roots extracted: ${aggregated.roots.size.toLocaleString()}`);
  console.log(`Baseline comparison: ${baseline.loaded ? `${baseline.count.toLocaleString()} words from ${baseline.path}` : "NOT LOADED"}`);
  console.log(`New roots discovered: ${newRoots.length.toLocaleString()} (${aggregated.newRoots.size.toLocaleString()} before freq filter)`);

  // Build cohort report
  const cohortReport = buildCohortReport(aggregated.newRoots);
  aggregated.cohortMatches = cohortReport;

  // Show cohort breakdown
  for (const [cohort, matches] of cohortReport) {
    if (matches.length > 0) {
      const desc = COHORT_PATTERNS[cohort]?.description || "Unclassified";
      const topRoots = matches.slice(0, 5).map(m => m.root).join(", ");
      console.log(`  ${cohort} (${matches.length}): ${topRoots}`);
    }
  }

  // --full: Cohort growth + HIBP + discovery
  let growthResults: CohortGrowthResult[] = [];
  let hibpPromoted: string[] = [];

  if (full && !dryRun) {
    // Discover potential new cohorts
    const unclassified = cohortReport.get("unclassified") || [];
    if (unclassified.length > 0) {
      console.log(`\nScanning ${unclassified.length} unclassified roots for new cohort patterns...`);
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

    // Grow existing cohort wordlists
    console.log(`\nGrowing existing cohort wordlists...`);
    growthResults = growExistingCohorts(cohortReport);
    if (growthResults.length > 0) {
      for (const g of growthResults) {
        console.log(`  ${g.cohort} → +${g.newMembers.length} new members to ${g.file}: ${g.newMembers.join(", ")}`);
      }
    } else {
      console.log(`  No new members to add`);
    }

    // HIBP validation for borderline roots
    const candidatesForHIBP: string[] = [];
    for (const [root, data] of aggregated.newRoots) {
      const alreadyIncluded = data.cohorts.length > 0 || (data.count >= 3 && root.length >= 5);
      if (!alreadyIncluded && root.length >= 4) {
        candidatesForHIBP.push(root);
      }
    }

    if (candidatesForHIBP.length > 0) {
      candidatesForHIBP.sort((a, b) => {
        const aData = aggregated.newRoots.get(a)!;
        const bData = aggregated.newRoots.get(b)!;
        if (bData.count !== aData.count) return bData.count - aData.count;
        return b.length - a.length;
      });

      const toCheck = candidatesForHIBP.slice(0, 500);
      console.log(`\nChecking ${toCheck.length} candidate roots against HIBP...`);
      const hibpResults = await batchQueryHIBP(toCheck);

      for (const [root, hibpCount] of hibpResults) {
        if (hibpCount >= HIBP_HIGH_THRESHOLD) {
          hibpPromoted.push(root);
          const data = aggregated.newRoots.get(root)!;
          console.log(`  HIBP promoted: ${root} (${hibpCount.toLocaleString()} breaches, ${data.count}x local)`);
        }
      }

      if (hibpPromoted.length === 0) {
        console.log(`  No roots met HIBP threshold (>=${HIBP_HIGH_THRESHOLD.toLocaleString()} breaches)`);
      }
    }
  }

  // Generate BETA.txt (discovered roots + cohort wordlists)
  const betaPath = resolve(FEEDBACK_DIR, "BETA.txt");
  let metricsDiscoveredTotal = 0;
  let metricsBetaSize = 0;
  let metricsNewDiscoveries = 0;

  if (!dryRun) {
    // Load previously discovered roots (persisted across batches)
    const discoveredRoots = new Set<string>();
    if (existsSync(DISCOVERED_ROOTS_PATH)) {
      const existing = readFileSync(DISCOVERED_ROOTS_PATH, "utf-8");
      for (const line of existing.split("\n")) {
        const word = line.trim().toLowerCase();
        if (word && !word.startsWith("#")) discoveredRoots.add(word);
      }
      console.log(`\n  Loaded ${discoveredRoots.size.toLocaleString()} previously discovered roots`);
    }

    // Add NEW roots from this batch + HIBP-promoted roots
    const newDiscoveries = newRoots.filter(r => !discoveredRoots.has(r.root));
    for (const r of newRoots) {
      discoveredRoots.add(r.root);
    }
    for (const root of hibpPromoted) {
      discoveredRoots.add(root);
    }
    console.log(`  +${newDiscoveries.length} new roots this batch (${discoveredRoots.size.toLocaleString()} total discovered)`);

    // Save updated discovered-roots.txt
    const discoveredContent = [
      "# discovered-roots.txt — Persistent root accumulation across ALL batches",
      `# Updated: ${new Date().toISOString()}`,
      `# Total: ${discoveredRoots.size} roots`,
      "#",
      ...Array.from(discoveredRoots).sort(),
    ].join("\n") + "\n";
    writeFileSync(DISCOVERED_ROOTS_PATH, discoveredContent);

    // Build BETA.txt: ALL discovered roots + ALL cohort words
    const betaWords = new Set(discoveredRoots);

    let cohortWordsAdded = 0;
    if (existsSync(COHORTS_DIR)) {
      const cohortFiles = readdirSync(COHORTS_DIR).filter(f => f.endsWith(".txt"));
      for (const file of cohortFiles) {
        const cohortPath = resolve(COHORTS_DIR, file);
        const content = readFileSync(cohortPath, "utf-8");
        for (const line of content.split("\n")) {
          const word = line.trim().toLowerCase();
          if (word && !word.startsWith("#")) {
            betaWords.add(word);
            cohortWordsAdded++;
          }
        }
      }
      console.log(`  Merged ${cohortWordsAdded.toLocaleString()} words from cohort wordlists`);
    }

    const betaContent = Array.from(betaWords).join("\n") + "\n";
    writeFileSync(betaPath, betaContent);
    console.log(`  Wrote ${betaWords.size.toLocaleString()} total words to ${betaPath}`);

    metricsDiscoveredTotal = discoveredRoots.size;
    metricsBetaSize = betaWords.size;
    metricsNewDiscoveries = newDiscoveries.length;
  }

  // Load baseline rules to filter against
  console.log(`\nLoading baseline rules for comparison...`);
  const baselineRules = await loadBaselineRules();
  if (baselineRules.loaded) {
    console.log(`  Baseline rules: ${baselineRules.count.toLocaleString()} from ${baselineRules.sources.join(", ")}`);
  } else {
    console.log(`  No baseline rules loaded - all generated rules will be included`);
  }

  // Generate pattern-based rules
  const candidateRules = new Set<string>();

  for (const [pattern, count] of aggregated.patterns) {
    const rule = patternToRule(pattern, count);
    if (rule) candidateRules.add(rule);
  }

  const suffixRules = generateSuffixRules(aggregated.suffixes);
  for (const rule of suffixRules) candidateRules.add(rule);

  for (let year = 2015; year <= 2026; year++) {
    candidateRules.add(`$${String(year)[0]} $${String(year)[1]} $${String(year)[2]} $${String(year)[3]}`);
  }

  candidateRules.add("c $1");
  candidateRules.add("c $1 $2 $3");
  candidateRules.add("c $!");
  candidateRules.add("l $1 $2 $3");
  candidateRules.add("u");
  candidateRules.add("sa@ se3 si1 so0");

  // Filter out rules already in baseline
  const newRulesList: string[] = [];
  let filteredCount = 0;
  for (const rule of candidateRules) {
    const normalizedRule = rule.replace(/\s+/g, " ");
    if (baselineRules.rules.has(normalizedRule)) {
      filteredCount++;
    } else {
      newRulesList.push(rule);
    }
  }

  console.log(`\nRules analysis:`);
  console.log(`  Candidate rules generated: ${candidateRules.size}`);
  console.log(`  Already in baseline: ${filteredCount} (filtered out)`);
  console.log(`  NEW rules: ${newRulesList.length}`);

  // Generate unobtainium.rule (preserves manual rules)
  const rulePath = resolve(FEEDBACK_DIR, "unobtainium.rule");
  if (!dryRun) {
    const manualRules: string[] = [];
    if (existsSync(rulePath)) {
      const existing = readFileSync(rulePath, "utf-8");
      let inManualSection = false;
      for (const line of existing.split("\n")) {
        if (line.startsWith("# Deep analysis") || line.startsWith("# Manual")) {
          inManualSection = true;
          manualRules.push(line);
        } else if (inManualSection && line.trim() !== "") {
          manualRules.push(line);
        } else if (inManualSection && line.trim() === "") {
          inManualSection = false;
        }
      }
    }

    const allNewRules = [...newRulesList];
    const ruleSet = new Set(newRulesList.map((r) => r.trim()));
    for (const mr of manualRules) {
      if (!mr.startsWith("#") && mr.trim() !== "" && !ruleSet.has(mr.trim())) {
        allNewRules.push(mr);
        ruleSet.add(mr.trim());
      }
    }

    const ruleLines = [
      "# UNOBTAINIUM.rule - Auto-generated from DIAMOND analysis",
      "#",
      "# PURPOSE: Rules discovered from cracked passwords (DIAMONDS) that are",
      "#          NOT already covered by OneRuleToRuleThemStill.rule or nocap.rule.",
      "#",
      `# Generated: ${new Date().toISOString()}`,
      `# Batches analyzed: ${batchesAnalyzed.join(", ")}`,
      `# Total passwords: ${aggregated.totalPasswords.toLocaleString()}`,
      `# Baseline filtered: ${filteredCount} rules (already in OneRule/nocap)`,
      `# New rules: ${allNewRules.length}`,
      "",
      "# NEW pattern-based rules (not in baseline)",
      ...newRulesList,
    ];

    if (manualRules.length > 0) {
      ruleLines.push("");
      ruleLines.push(...manualRules);
    }

    ruleLines.push("");
    writeFileSync(rulePath, ruleLines.join("\n"));
    const manualCount = manualRules.filter((r) => !r.startsWith("#")).length;
    console.log(`  Wrote ${newRulesList.length} auto + ${manualCount} manual rules to ${rulePath}`);
  }

  // Print analysis summary
  console.log("\n" + "=".repeat(60));
  console.log("FEEDBACK ANALYSIS SUMMARY");
  console.log("=".repeat(60));

  console.log("\nTop 10 NEW Root Words:");
  for (const { root, count } of newRoots.slice(0, 10)) {
    const data = aggregated.newRoots.get(root);
    const cohortStr = data && data.cohorts.length > 0 ? ` [${data.cohorts.join(", ")}]` : "";
    console.log(`  ${root}: ${count} occurrences${cohortStr}`);
  }

  console.log("\nTop 10 Patterns:");
  const topPatterns = Array.from(aggregated.patterns.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [pattern, count] of topPatterns) {
    const pct = ((count / aggregated.uniquePasswords) * 100).toFixed(1);
    console.log(`  ${pattern}: ${count.toLocaleString()} (${pct}%)`);
  }

  console.log("\nTop 10 Suffixes:");
  const topSuffixes = Array.from(aggregated.suffixes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [suffix, count] of topSuffixes) {
    console.log(`  "${suffix}": ${count.toLocaleString()}`);
  }

  console.log("\nCharset Distribution:");
  const total = aggregated.uniquePasswords;
  console.log(`  Lowercase only: ${aggregated.charsetDistribution.lowercase.toLocaleString()} (${((aggregated.charsetDistribution.lowercase / total) * 100).toFixed(1)}%)`);
  console.log(`  Uppercase only: ${aggregated.charsetDistribution.uppercase.toLocaleString()} (${((aggregated.charsetDistribution.uppercase / total) * 100).toFixed(1)}%)`);
  console.log(`  Digits only: ${aggregated.charsetDistribution.digits.toLocaleString()} (${((aggregated.charsetDistribution.digits / total) * 100).toFixed(1)}%)`);
  console.log(`  Mixed: ${aggregated.charsetDistribution.mixed.toLocaleString()} (${((aggregated.charsetDistribution.mixed / total) * 100).toFixed(1)}%)`);

  console.log("\nLength Distribution:");
  const lengths = Array.from(aggregated.lengthDistribution.entries())
    .sort((a, b) => a[0] - b[0]);
  for (const [len, count] of lengths.slice(0, 12)) {
    const bar = "#".repeat(Math.min(40, Math.round(count / total * 200)));
    console.log(`  ${len.toString().padStart(2)}: ${bar} ${count.toLocaleString()}`);
  }

  // --full: Generate cohort report
  if (full && !dryRun) {
    console.log(`\nGenerating cohort report...`);
    const reportPath = resolve(FEEDBACK_DIR, "cohort-report.md");
    generateCohortReport(aggregated, cohortReport, growthResults, reportPath);
    console.log(`  Saved to: ${reportPath}`);
  }

  // Generate feedback-report.json
  const report: FeedbackReport = {
    timestamp: new Date().toISOString(),
    batchesAnalyzed,
    totalDiamonds: aggregated.totalPasswords,
    uniquePasswords: aggregated.uniquePasswords,
    structuredCount: aggregated.structuredCount,
    randomCount: aggregated.randomCount,
    baselineLoaded: baseline.loaded,
    baselinePath: baseline.path,
    baselineRootCount: baseline.count,
    baselineRulesLoaded: baselineRules.loaded,
    baselineRuleSources: baselineRules.sources,
    baselineRuleCount: baselineRules.count,
    totalRootsExtracted: aggregated.roots.size,
    newRoots: newRoots.length,
    candidateRules: candidateRules.size,
    filteredRules: filteredCount,
    newRules: newRulesList.length,
    topNewRoots: newRoots.slice(0, 20).map(r => r.root),
    topPatterns: topPatterns.map(([p, _]) => p),
    betaPath,
    rulePath,
  };

  const reportPath = resolve(FEEDBACK_DIR, "feedback-report.json");
  if (!dryRun) {
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${reportPath}`);
  }

  // Update sand-state.json with feedback metrics
  if (!dryRun && existsSync(SAND_STATE_PATH)) {
    try {
      const sandState = JSON.parse(readFileSync(SAND_STATE_PATH, "utf-8"));
      const rawBatch = batchesAnalyzed[batchesAnalyzed.length - 1];
      const targetBatch = rawBatch?.replace(/^passwords-/, "") || rawBatch;
      if (targetBatch && sandState.batches?.[targetBatch]) {
        const FEEDBACK_PREFIXES = ["feedback-", "nocapplus-"];
        const attackResults: Array<{ attack: string; newCracks: number }> =
          sandState.batches[targetBatch].attackResults || [];
        const feedbackCracks = attackResults
          .filter((r: { attack: string }) => FEEDBACK_PREFIXES.some(p => r.attack.startsWith(p)))
          .reduce((sum: number, r: { newCracks: number }) => sum + r.newCracks, 0);

        sandState.batches[targetBatch].feedback = {
          newRootsDiscovered: metricsNewDiscoveries,
          hibpPromoted: hibpPromoted.length,
          totalDiscoveredRoots: metricsDiscoveredTotal,
          betaSize: metricsBetaSize,
          nocapPlusSize: 0,  // populated by rebuild-nocap-plus.py
          feedbackCracks,
        };
        writeFileSync(SAND_STATE_PATH, JSON.stringify(sandState, null, 2));
        console.log(`  Updated sand-state.json feedback metrics for ${targetBatch} (feedbackCracks: ${feedbackCracks})`);
      }
    } catch (e) {
      console.log(`  Warning: Could not update sand-state.json: ${e}`);
    }
  }

  return report;
}

// =============================================================================
// Standalone File Analysis (--analyze)
// =============================================================================

async function analyzeStandalone(filePath: string, full: boolean): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`DiamondFeedback — Standalone Analysis`);
  console.log(`${"=".repeat(60)}\n`);
  console.log(`Input: ${filePath}\n`);

  // Step 1: Analyze passwords
  console.log("Step 1: Classifying passwords (structured vs random)...");
  const result = await analyzeFile(filePath);

  console.log(`  Total: ${result.totalPasswords.toLocaleString()}`);
  console.log(`  Unique: ${result.uniquePasswords.toLocaleString()}`);
  console.log(`  Structured: ${result.structuredCount.toLocaleString()} (${((result.structuredCount / result.uniquePasswords) * 100).toFixed(1)}%)`);
  console.log(`  Random: ${result.randomCount.toLocaleString()} (${((result.randomCount / result.uniquePasswords) * 100).toFixed(1)}%)`);
  console.log(`  Unique roots: ${result.roots.size.toLocaleString()}`);

  // Step 2: Compare roots against baseline (streams — no bulk memory load)
  console.log("\nStep 2: Comparing roots against baseline...");
  const { newRoots: discoveredNewRoots2, baseline } = await findNewRoots(result.roots);
  result.newRoots = discoveredNewRoots2;
  console.log(`  New roots (not in baseline): ${result.newRoots.size.toLocaleString()}`);

  // Step 3: Cohort classification
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

  // Step 3b: Discover potential new cohorts
  const unclassified = cohortReport.get("unclassified") || [];
  if (unclassified.length > 0) {
    console.log(`\nStep 3b: Scanning ${unclassified.length} unclassified roots...`);
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

  // Step 3c: Grow existing cohorts (only with --full)
  let growthResults: CohortGrowthResult[] = [];
  if (full) {
    console.log("\nStep 3c: Growing existing cohort wordlists...");
    growthResults = growExistingCohorts(cohortReport);
    if (growthResults.length > 0) {
      for (const g of growthResults) {
        console.log(`  ${g.cohort} → +${g.newMembers.length} new members to ${g.file}: ${g.newMembers.join(", ")}`);
      }
    } else {
      console.log(`  No new members to add`);
    }
  }

  // Top roots
  console.log("\nTop 20 new roots by frequency:");
  const topNew = Array.from(result.newRoots.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20);
  for (const [root, data] of topNew) {
    const cohortStr = data.cohorts.length > 0 ? ` [${data.cohorts.join(", ")}]` : "";
    console.log(`  ${root} (${data.count}x)${cohortStr} — ${data.examples.slice(0, 2).join(", ")}`);
  }

  // Write outputs if --full
  if (full) {
    if (!existsSync(FEEDBACK_DIR)) mkdirSync(FEEDBACK_DIR, { recursive: true });

    console.log("\nGenerating outputs...");
    const reportPath = resolve(FEEDBACK_DIR, "cohort-report.md");
    generateCohortReport(result, cohortReport, growthResults, reportPath);
    console.log(`  Cohort report: ${reportPath}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("Analysis complete.");
  console.log(`${"=".repeat(60)}\n`);
}

// =============================================================================
// CLI Entry Point
// =============================================================================

function printHelp(): void {
  console.log(`
DiamondFeedback - Analyze DIAMONDS to Extract Feedback for Next Batch

Merged tool: combines pattern analysis, cohort classification, and feedback
generation into a single step. Replaces both DiamondAnalyzer and old DiamondFeedback.

Usage:
  bun DiamondFeedback.ts --batch batch-0001          Standard feedback (fast)
  bun DiamondFeedback.ts --batch batch-0001 --full    Full analysis + HIBP + cohort growth
  bun DiamondFeedback.ts --analyze <file>             Analyze standalone file
  bun DiamondFeedback.ts --analyze <file> --full      Analyze + cohort growth + report
  bun DiamondFeedback.ts --dry-run                    Preview without writing files

Options:
  --batch <name>     Analyze specific batch (can specify multiple)
  --full             Enable HIBP queries, cohort growth, cohort-report.md
  --analyze <file>   Analyze a standalone password file
  --min-freq <n>     Minimum root frequency (default: ${MIN_ROOT_FREQUENCY})
  --dry-run          Preview analysis without writing files

Output Files:
  data/feedback/BETA.txt             New root words + cohort words
  data/feedback/unobtainium.rule     New rules from patterns
  data/feedback/feedback-report.json Analysis report
  data/feedback/cohort-report.md     Cohort report (--full only)
  data/feedback/discovered-roots.txt Persistent root accumulation

Workflow:
  1. Run DiamondFeedback after collecting diamonds
  2. Rebuild nocap-plus.txt if cohorts changed
  3. Sync updated assets to BIGRED
`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // Parse arguments
  const batches: string[] = [];
  let minRootFreq = MIN_ROOT_FREQUENCY;
  let full = false;
  let dryRun = false;
  let analyzeFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch":
        batches.push(args[++i]);
        break;
      case "--min-freq":
        minRootFreq = parseInt(args[++i]) || MIN_ROOT_FREQUENCY;
        break;
      case "--full":
        full = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--analyze":
        analyzeFile = args[++i];
        break;
    }
  }

  try {
    if (analyzeFile) {
      // Standalone file analysis mode
      if (!existsSync(analyzeFile)) {
        console.error(`Input file not found: ${analyzeFile}`);
        process.exit(1);
      }
      await analyzeStandalone(analyzeFile, full);
    } else {
      // Standard batch feedback mode
      await generateFeedback({
        batches: batches.length > 0 ? batches : undefined,
        minRootFreq,
        full,
        dryRun,
      });
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
