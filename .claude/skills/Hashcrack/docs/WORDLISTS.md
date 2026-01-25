# Passphrase Wordlist Sources

Long passphrases (10+ chars) require specialized wordlists. As NIST 2025 guidelines push organizations toward 15+ character passphrases, predictable patterns are emerging. Users follow predictable patterns: song lyrics, movie quotes, memes, and initialisms.

## Tier 1: Essential Passphrase Wordlists

| Source | Size | Update Freq | Best For | URL |
|--------|------|-------------|----------|-----|
| **initstring/passphrase-wordlist** | 20M+ phrases | Periodic | Movie quotes, lyrics, book titles | [GitHub](https://github.com/initstring/passphrase-wordlist) |
| **Have I Been Pwned** | 900M+ | Monthly | Real breach passwords (SHA1/NTLM) | [HIBP Passwords](https://haveibeenpwned.com/Passwords) |
| **Kaonashi** | 2.35GB | Stable | Sorted by occurrence frequency | [GitHub](https://github.com/kaonashi-passwords/Kaonashi) |
| **WeakPass** | Various | Active | Large wordlist collection | [weakpass.com](https://weakpass.com/) |
| **CrackStation** | 15GB | Stable | Wikipedia + breaches + books | [crackstation.net](https://crackstation.net/crackstation-wordlist-password-cracking-dictionary.htm) |

## Tier 2: Dynamic/Trending Sources

These sources update frequently and capture current cultural trends:

| Source | Update Freq | Content Type | Access |
|--------|-------------|--------------|--------|
| **Know Your Meme** | Daily | Meme phrases, catchphrases | [knowyourmeme.com](https://knowyourmeme.com/) |
| **Urban Dictionary** | Daily | Slang, trending phrases | [urbandictionary.com](https://www.urbandictionary.com/) |
| **Google Trends** | Real-time | Trending searches | [pytrends](https://github.com/GeneralMills/pytrends) |
| **Billboard Charts** | Weekly | Song titles, artist names | [billboard.com](https://www.billboard.com/charts/) |
| **IMDB** | Weekly | Movie/TV titles, character names | [imdb.com/interfaces](https://www.imdb.com/interfaces/) |

## Tier 3: Specialized Tools

| Tool | Purpose | URL |
|------|---------|-----|
| **LyricPass** | Generate wordlists from song lyrics | [GitHub](https://github.com/initstring/lyricpass) |
| **Phraser** | N-gram/Markov chain phrase generation | [GitHub](https://github.com/Sparell/Phraser) |
| **Mentalist** | GUI for custom wordlist creation | [GitHub](https://github.com/sc0tfree/mentalist) |
| **PACK** | Analyze passwords for pattern masks | [GitHub](https://github.com/iphelix/pack) |
| **Wordlust** | Combined dictionary (movies, lyrics, phrases) | [GitHub](https://github.com/frizb/Wordlust) |

## initstring/passphrase-wordlist Details

**20M+ phrases** compiled from dynamic and static sources:

**Dynamic Sources (Updated Periodically):**
- Wikipedia/Wiktionary article titles
- Urban Dictionary entries
- Know Your Meme database
- IMDB movie/TV dataset
- Billboard music charts
- Global points of interest

**Static Sources:**
- Cornell Movie-Dialogs corpus
- Book titles (Kaggle)
- Famous quotes databases
- Common English phrases

**Hashcat Rules Included:**
- `passphrase-rule1.rule` - Capitalization, spacing variations
- `passphrase-rule2.rule` - Character substitutions, mutations
- Together generate **1000+ permutations per phrase**

## Initialism/Acronym Patterns

Users often create passwords from **first letters of phrases**:

| Phrase | Initialism Password |
|--------|---------------------|
| "To be or not to be" | `tbontb` or `Tbontb1!` |
| "Live laugh love" | `lll` or `LLL2024` |
| "Make America Great Again" | `maga` or `MAGA!` |
| "You only live once" | `yolo` or `Yolo123` |
| "What would Jesus do" | `wwjd` or `WWJD!` |

**Detection Strategy:**
1. Generate initialisms from known phrase lists
2. Apply standard mutation rules (capitalize, add numbers/symbols)
3. Run as high-priority pretask before brute force

## 2025-2026 Trending Passphrase Patterns

Based on NIST guidance pushing 15+ char passwords, these patterns are emerging:

| Pattern | Example | Prevalence |
|---------|---------|------------|
| **Season+Year+Symbol** | `Winter2025!` | Very High |
| **Phrase+Numbers** | `letmein123456` | High |
| **Movie/Song Titles** | `MayTheForceBeWithYou` | Medium |
| **Meme References** | `itsgivingmaincharacter` | Growing |
| **Sports+Year** | `GoPackGo2025!` | Regional |
| **3-4 Word Combos** | `correct horse battery` | Emerging |

## Standard Test Wordlists & Rules

For Hashcrack skill testing, use these **verified** download URLs:

```bash
# RockYou wordlist (14.3M passwords, 139MB)
curl -sLO https://github.com/brannondorsey/naive-hashcat/releases/download/data/rockyou.txt
wc -l rockyou.txt  # Expected: 14344391

# OneRuleToRuleThemStill (48K rules, 486KB)
# VERIFIED SOURCE - Other GitHub repos return 404
curl -sL https://raw.githubusercontent.com/stealthsploit/OneRuleToRuleThemStill/main/OneRuleToRuleThemStill.rule -o OneRuleToRuleThemStill.rule
wc -l OneRuleToRuleThemStill.rule  # Expected: 48439

# best64 rules (included with hashcat)
# Location: /usr/share/hashcat/rules/best64.rule
```

**Keyspace Calculation for Rule Attacks:**
```
Keyspace = wordlist_lines × rule_lines
RockYou + OneRule = 14,344,391 × 48,439 = 694,827,955,649 (~695B)
```

## Quick Download Commands

```bash
# Essential passphrase wordlist (20M+ phrases)
wget https://github.com/initstring/passphrase-wordlist/releases/latest/download/passphrases.txt.gz
gunzip passphrases.txt.gz

# Kaonashi (sorted by frequency - most effective first)
wget https://github.com/kaonashi-passwords/Kaonashi/releases/download/v1.0/kaonashi.txt.7z

# HIBP Pwned Passwords (NTLM format for AD audits)
# Use the downloader tool for full 900M+ dataset
git clone https://github.com/HaveIBeenPwned/PwnedPasswordsDownloader
dotnet run -- -n -o pwned-passwords-ntlm

# SecLists common credentials
wget https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/10k-most-common.txt

# Generate lyrics-based wordlist for specific artist
pip install lyricpass
lyricpass -a "Taylor Swift" -o taylor_swift_lyrics.txt
```

## Recommended Attack Order for Passphrases

| Priority | Attack | Wordlist | Expected Hits |
|----------|--------|----------|---------------|
| 1 | Direct passphrase | passphrases.txt | 5-10% |
| 2 | Passphrase + rules | passphrases.txt + passphrase-rule1/2 | 10-20% |
| 3 | Kaonashi top 10M | kaonashi-top10m.txt | 15-25% |
| 4 | HIBP common | pwned-passwords-top1m.txt | 20-30% |
| 5 | Initialism generation | Custom from phrases | 2-5% |
| 6 | Trending + mutations | Urban Dict + rules | 1-3% |

## Building Custom Trending Wordlists

```python
# Example: Generate wordlist from Google Trends
from pytrends.request import TrendReq

pytrends = TrendReq()
# Get daily trending searches
trending = pytrends.trending_searches(pn='united_states')

# Save as wordlist
with open('trending_phrases.txt', 'w') as f:
    for phrase in trending[0]:
        # Original
        f.write(f"{phrase}\n")
        # No spaces
        f.write(f"{phrase.replace(' ', '')}\n")
        # Lowercase no spaces
        f.write(f"{phrase.replace(' ', '').lower()}\n")
```

## Cross-Hash Type Password Reuse Detection

When auditing mixed hash types (MD5, SHA512crypt, NTLM), immediately reuse cracked passwords:

```bash
# After cracking MD5 hashes, extract plaintext passwords
awk -F: '{print $2}' cracked_md5.txt > reuse_wordlist.txt

# Run against other hash types with highest priority
hashcat -m 1800 linux_shadow.txt reuse_wordlist.txt  # SHA512crypt
hashcat -m 1000 ntlm_hashes.txt reuse_wordlist.txt   # NTLM
```

**Multi-Hash Audit Workflow:**
1. Load ALL hash types as separate hashlists (MD5, SHA512, NTLM, etc.)
2. Run initial wordlist attacks on the fastest hash type first (MD5/NTLM)
3. After any crack, IMMEDIATELY add password to `reuse_wordlist.txt`
4. Run `reuse_wordlist.txt` against ALL other hashlists
5. Password reuse is extremely common - this catches ~30% of additional cracks

## Building Custom Passphrase Lists

```bash
# Extract long passwords from potfile
awk -F: 'length($2) >= 10 {print $2}' hashcat.potfile > long_passwords.txt

# Find most common patterns
sort long_passwords.txt | uniq -c | sort -rn | head -100
```
