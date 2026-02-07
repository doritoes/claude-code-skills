# Cohort Analysis: Predicting Unseen Password Roots

## Discovery Date: 2026-02-07
## Source: Brute-8 attack on SAND batch-0001

---

## Key Insight

**Brute force attacks reveal COHORTS, not just individual words.**

When we crack `oguz1234`, we're not just finding one password - we're discovering that **Turkish names** are a cohort missing from our wordlists. This predicts THOUSANDS of unseen passwords like:
- oguz, yusuf, mehmet, ahmet, mustafa, emre, burak, serkan, tolga, baris...

The same pattern applies to every cultural/linguistic cohort we discover.

---

## Discovered Cohorts (Feb 2026)

### 1. Turkish Names (HIGH VALUE)
**Evidence:** `oguz`, `elif`, `yekta` found in brute-8 cracks, NOT in nocap.txt

**Predicted unseen roots:**
- Masculine: yusuf, mehmet, ahmet, mustafa, emre, burak, serkan, tolga, baris, cem, kaan, onur, arda, berkay, furkan
- Feminine: elif, zeynep, ece, selin, irem, melis, defne, buse, dilara, cansu, ebru, gamze, pinar

**Estimated coverage gap:** 500-2000 common Turkish names

**Action:** Add Turkish names wordlist

---

### 2. Indian/South Asian Names (HIGH VALUE)
**Evidence:** `abhi`, `anuj`, `anup`, `arif`, `ashu` found in brute-8, NOT in nocap.txt

**Predicted unseen roots:**
- Hindi: amit, anil, arun, ashok, deepak, gaurav, kapil, manoj, nitin, pankaj, rahul, rajesh, sanjay, sunil, vijay, vinod
- Short forms: abhi, anu, ashu, ravi, sonu, monu, guddu, pappu, tinku, rinku
- Muslim: arif, asif, imran, irfan, nadeem, nasir, rashid, saleem, shahid, tariq, wasim, zaheer

**Estimated coverage gap:** 2000-5000 common Indian names

**Action:** Add Hindi/Urdu names wordlist, Indian nickname list

---

### 3. Arabic/Middle Eastern Names (MEDIUM-HIGH VALUE)
**Evidence:** `umer`, `ehab`, `afroz` found in brute-8, NOT in nocap.txt

**Predicted unseen roots:**
- Arabic: ahmed, ali, hassan, hussein, khalid, mahmoud, mohamed, omar, youssef, zaid
- Variants: umer (umar), ehab (ihab), hamza, bilal, faisal, nabil, rami, sami, tarek, walid
- Persian: afroz, arash, babak, cyrus, darius, farhad, kaveh, mehrdad, reza, shahram

**Estimated coverage gap:** 1000-3000 common Arabic/Persian names

**Action:** Add Arabic names wordlist, Persian names wordlist

---

### 4. Slavic/Eastern European Names (MEDIUM VALUE)
**Evidence:** `olia`, `maks`, `vlad`, `dima`, `egor` - some in nocap, variants missing

**Predicted unseen roots:**
- Russian diminutives: olia (olya), maks, dima, vova, sasha, misha, kolya, petya, vanya, zhenya
- Ukrainian: oksana, taras, bogdan, yaroslav, svitlana, iryna
- Polish: kasia, basia, tomek, marek, pawel, piotr, jacek

**Estimated coverage gap:** 500-1500 Slavic diminutives

**Action:** Add Russian/Ukrainian diminutives list

---

### 5. Chinese Names (MEDIUM VALUE)
**Evidence:** `xiao`, `zhou` found, many romanized Chinese names missing

**Predicted unseen roots:**
- Common surnames: wang, zhang, li, liu, chen, yang, huang, zhao, wu, zhou
- Given names: wei, jing, ming, xiao, lin, lei, hui, yan, fang, hong
- Pinyin patterns: usually 4-6 chars, consonant-vowel structure

**Estimated coverage gap:** 1000-3000 romanized Chinese names

**Action:** Add Pinyin names wordlist

---

### 6. Cultural Terms & Loanwords (LOW-MEDIUM VALUE)
**Evidence:** `yatra`, `puja`, `acai`, `taka` found

**Predicted unseen roots:**
- Hindi/Sanskrit: yoga, karma, dharma, mantra, chakra, guru, namaste, diwali, holi
- Japanese: kawaii, sensei, senpai, otaku, anime, manga, ramen, sake, tofu
- Spanish: amigo, hola, loco, amor, vida, fiesta, siesta
- Food/trends: acai, matcha, kombucha, quinoa, kale

**Estimated coverage gap:** 200-500 cultural terms

**Action:** Add international loanwords list

---

### 7. Cricket (HIGH VALUE - Large Global Fanbase)
**Evidence:** Checked nocap.txt coverage - significant gaps in current players and IPL teams

**MISSING from nocap.txt:**
- **Current Stars:** virat, kohli, bumrah, pant (India's biggest current players!)
- **IPL Teams:** ipl, csk, rcb, mi, kkr, sunrisers (major league abbreviations)
- **Compounds:** viratkohli, meninblue
- **Stadiums:** wankhede, chinnaswamy
- **International:** labuschagne, lyon, woakes

**Predicted unseen roots:**
- IPL team abbreviations: csk, rcb, mi, kkr, srh, dc, pbks, rr, lsg, gt
- Player nicknames: thala, hitman, king, gabbar, boom, sky, surya
- Fan phrases: bleedblue, yellowarmy, whistlepodu, korbolorbojeetbo
- Match terms: sixers, boundaries, powerplay, supersixes

**Estimated coverage gap:** 200-500 cricket terms

**Action:** Add IPL teams list, current cricket stars, fan culture terms

---

### 8. American Sports - Current Era (MEDIUM-HIGH VALUE)
**Evidence:** Checked nocap.txt - classic players covered, recent stars missing

**MISSING from nocap.txt:**
- **NBA:** jokic, embiid, wembanyama, banchero, kuminga
- **Soccer:** foden, vini (vinicius jr)
- **Fan Culture:** billsmafia, chiefskingdom

**Predicted unseen roots:**
- Rising NBA: wemby, chet, scoot, amen, ausar, bronny
- Current NFL: stroud, bryce, bijan, hooker, levis
- Fan hashtags: dubnation, lakernation, ravensflock, chiefsmafia
- Fantasy/betting: parlay, props, dfs, underdog

**Estimated coverage gap:** 100-300 current sports terms

**Action:** Add current player names (2020+), team fan culture terms

---

### 9. College Sports (MEDIUM VALUE)
**Evidence:** Good team coverage, but abbreviations and slogans missing

**MISSING from nocap.txt:**
- **Abbreviations:** osu, uga, nd (Ohio State, Georgia, Notre Dame)
- **Basketball:** zags, boilermakers
- **March Madness:** marchmadness, bigdance, bracketbuster, oneshiningmoment
- **Slogans:** fightingillini

**Predicted unseen roots:**
- School abbreviations: osu, uga, nd, lsu, usc, ucla, unc, uk, ku
- Slogans: goirish, wareagle, hottytoddty, gthc, hookem, gbo, wps
- March Madness: bracketbuster, oneshiningmoment, bigdance, busted, upset
- Rivalry terms: theGame, ironbowl, redriver, backyard

**Estimated coverage gap:** 100-200 college sports terms

**Action:** Add college abbreviations, tournament terms, rivalry names

---

### 10. Streetwear & Hype Culture (MEDIUM VALUE)
**Evidence:** Checked luxury/streetwear brands - some major ones missing

**MISSING from nocap.txt:**
- **Brands:** bape, yeezy, vlone, fog (Fear of God)
- **Culture terms:** hypebeast, grail, deadstock, copped

**Predicted unseen roots:**
- Brands: bape, yeezy, vlone, fog, rhude, alyx, margiela, cpfm
- Drops: snkrs, confirmed, raffle, restock, soldout
- Resale: stockx, goat, grailed, poshmark

**Estimated coverage gap:** 50-150 hype culture terms

**Action:** Add streetwear brands and culture vocabulary

---

### 11. Music - Artists, Albums & Fandoms (MEDIUM-HIGH VALUE)
**Evidence:** Checked rockyou.txt coverage - many 2009-era artists covered, but post-2015 gaps exist

**COVERED (surprisingly good from 2009 rockyou):**
- Major artists: beyonce, rihanna, taylorswift, nickiminaj, olivia, rodrigo, billie, eilish, doja, lizzo, megan, stallion, cardi, dababy, travisscott, selenagomez, justinbieber
- Albums: scorpion, astroworld, folklore, evermore, midnights, sour, reputation, positions, afterhours, renaissance
- Songs: despacito, rockstar, sunflower, havana, hotline, goosebumps, blinding, levitating
- Some fandoms: swiftie, swifties, barbz, mixer, army, blink, orbit, stay, moa, engene

**MISSING from rockyou.txt:**
- **Current Artists:** sza, dua, lipa, badbunny, ateez, weeknd, theweeknd
- **Compound Names:** postmalone, arianagrande, shawnmendes, harrystyles, onedirection
- **K-pop Individual Names:** jungkook, jimin, yoongi, namjoon, seokjin, hoseok, jisoo, yeji
- **Recent Albums/Tours:** donda, eras, futurenostalgia, dawnfm, erastour
- **Fandom Names:** belieber, directioner, lovatic, selenator, harmonizer, arianator, beyhive

**Predicted unseen roots:**
- Current era artists: sza, dua, lipa, badbunny, benito, ateez, enhypen, newjeans
- BTS members: jungkook, jimin, yoongi, namjoon, seokjin, hoseok (taehyung covered)
- Album/tour names: donda, erastour, eras, futurenostalgia, dawnfm, certified, utopia
- Compound artist names: postmalone, arianagrande, shawnmendes, harrystyles
- Missing fandoms: belieber, directioner, lovatic, selenator, harmonizer, arianator, beyhive
- K-pop groups: ateez, enhypen, newjeans, aespa, lesserafim, ive, nmixx

**Estimated coverage gap:** 100-300 music terms

**Action:** Add current artists (2015+), K-pop member names, recent album titles, fandom names

---

## Cohort Value Formula

```
Cohort Value = (estimated_unseen_count) × (usage_frequency) × (rule_compatibility)

Where:
- estimated_unseen_count: How many names/words in this cohort we DON'T have
- usage_frequency: How common these are in real passwords (based on HIBP frequency)
- rule_compatibility: How well standard rules (OneRule) transform these
```

**High Value Cohorts:**
1. Indian names (large population, English-alphabet compatible)
2. Turkish names (large population, English-alphabet compatible)
3. Arabic names (large population, common romanization)

**Medium Value Cohorts:**
4. Slavic diminutives (many variants of names we have)
5. Chinese Pinyin (large population, but tonal complexity)

---

## Implementation Priority

| Priority | Cohort | Est. New Roots | Effort | Notes |
|----------|--------|----------------|--------|-------|
| 1 | Indian names | 2000-5000 | Find curated list | Huge user base |
| 2 | Cricket (IPL/Players) | 200-500 | Manual curation | virat, kohli, csk, rcb missing! |
| 3 | Turkish names | 500-2000 | Find curated list | Large gap |
| 4 | Arabic names | 1000-3000 | Find curated list | Large gap |
| 5 | Music (K-pop/Current) | 100-300 | Manual curation | jungkook, sza, dua, badbunny |
| 6 | Current NBA/NFL stars | 100-300 | Manual curation | jokic, embiid, wembanyama |
| 7 | Slavic diminutives | 500-1500 | Extract from databases | Many variants |
| 8 | Chinese Pinyin | 1000-3000 | Generate from databases | Complex |
| 9 | College sports | 100-200 | Manual curation | osu, uga, nd |
| 10 | Streetwear/Hype | 50-150 | Manual curation | bape, yeezy, vlone |

---

## How to Use This Analysis

### For DiamondFeedback
When extracting roots from DIAMONDS, flag roots that match cohort patterns:
- Ends in common suffixes: -ul, -an, -in, -ov, -ev (Slavic)
- Starts with common prefixes: al-, abd-, abu- (Arabic)
- Contains: xh, zh, qi, xi (Chinese Pinyin)
- Short 4-5 char names not in English dictionaries

### For BETA.txt
Group discovered roots by cohort, then research full cohort lists:
- Don't just add `oguz` - add the full Turkish names list
- Don't just add `abhi` - add Indian nicknames + full names

### For Attack Strategy
Test new cohort wordlists with:
1. Cohort wordlist + OneRuleToRuleThemStill.rule
2. Cohort wordlist + year suffixes (2020-2026)
3. Cohort wordlist + 4-digit suffixes

---

## Appendix: Evidence from Brute-8

### Sample 8-char cracks revealing cohorts:
```
oguz1234  → Turkish name cohort
elif2023  → Turkish name cohort
abhi@123  → Indian name cohort
anuj1990  → Indian name cohort
umer2022  → Arabic name cohort
xiao1234  → Chinese name cohort
maks2000  → Slavic diminutive cohort
yatra123  → Hindi loanword cohort
```

### Pattern: International names + simple suffix
Most cracks follow: `[4-6 char name][2-4 digit suffix]`

This suggests:
1. People use their names as password bases
2. Standard rules (append digits) apply universally
3. We're missing the NAME BASES, not the rules

---

## Next Steps

1. [ ] Source curated name lists for each cohort
2. [ ] Test cohort wordlists on SAND batches
3. [ ] Measure crack rate improvement per cohort
4. [ ] Add high-performing cohorts to nocap.txt
5. [ ] Update rizzyou.txt with international names
