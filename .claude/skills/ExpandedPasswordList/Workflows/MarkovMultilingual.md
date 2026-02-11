# Markov Multilingual Expansion — Spanish & French

## Language Selection Rationale

### Why Spanish (#1)
- **363M internet users** — largest non-English Latin-script population
- **1B+ LATAM credentials** recovered from stealer logs (CrowdStrike 2025)
- Rich concatenated-phrase culture: "teamo", "tequiero", "princesa", "corazon"
- Native Latin script — zero romanization friction
- Only a stub DISCOVERY_PATTERN existed prior to this work

### Why French (#2)
- **151M internet users** — #2 global breach exposure rate (H1 2025)
- **AZERTY keyboard layout** causes friction with numbers → French users disproportionately favor word-based passwords (only 3/20 top passwords are numeric vs ~50% globally)
- This makes French **uniquely Markov-amenable** among all languages
- Richelieu project confirms word-heavy patterns: doudou, soleil, jetaime, coucou, motdepasse
- Native Latin script — zero romanization friction

### Languages Considered but Not Selected
| Language | Why Not |
|----------|---------|
| Japanese | Romanization preprocessing adds friction; partially covered by anime-manga DISCOVERY_PATTERN |
| German | 50%+ numeric passwords reduce Markov surface area |
| Indonesian | 52% numeric passwords; limited phrase culture documented |
| Vietnamese | Tonal language pushes users toward numbers; 52% numeric |

---

## Corpora Inventory

### Spanish
| Source | Lines | Type | Path |
|--------|-------|------|------|
| Leipzig News 2024 | 1,000,000 | News sentences | `scratchpad/corpus/spanish/spa_news_2024_1M/` |
| Twitter (clean) | 70,689 | Social media | `scratchpad/corpus/spanish/es_tweets_clean.txt` |
| Twitter (negative) | 122,135 | Social media | `scratchpad/corpus/spanish/es_tweets_neg.txt` |
| Twitter (positive) | 55,287 | Social media | `scratchpad/corpus/spanish/es_tweets_pos.txt` |
| Top Subtitle Sentences | 10,000 | Frequency-weighted | `scratchpad/corpus/spanish/es_top_sentences.csv` |
| **TOTAL** | **~1,258,000** | | |

### French
| Source | Lines | Type | Path |
|--------|-------|------|------|
| Leipzig News 2024 | 1,000,000 | News sentences | `scratchpad/corpus/french/fra_news_2024_1M/` |
| Top Subtitle Sentences | 10,000 | Frequency-weighted | `scratchpad/corpus/french/fr_top_sentences.csv` |
| Richelieu (validation) | 20,000 | Password list | `scratchpad/corpus/french/richelieu_fr_top20000.txt` |
| French Dictionary | 605,834 | Reference | `scratchpad/corpus/french/dictionnaire_fr.txt` |
| French First Names | 208,886 | Reference | `scratchpad/corpus/french/prenoms_fr.txt` |
| **TOTAL** | **~1,010,000** (training) | | |

---

## Validation Plan

### Hypothesis
Spanish and French Markov chains will achieve **>=5% HIBP hit rate** on new password candidates not in the nocap-plus.txt baseline. This is lower than the English 8-9% ceiling because:
- Smaller corpora (1.2M vs English's ~1M across 4 diverse sources)
- News register may produce more formal phrases vs English tweets/movies
- But compensated by strong cultural phrase patterns in both languages

### Method
```bash
# Phase 1: Validation run (small budget, measure hit rate)
bun run scratchpad/markov-multilingual-harvest.ts --language spanish --mode validate --budget 4000
bun run scratchpad/markov-multilingual-harvest.ts --language french --mode validate --budget 4000
```

Each validation run:
1. Trains Markov model on language-specific corpora
2. Generates ~2K candidates per language (2-word + 3-word chains)
3. Filters against nocap-plus.txt baseline (14.37M words)
4. Validates each candidate against HIBP k-anonymity API
5. Records hit rate, tier distribution, and top discoveries

### Success Criteria

| Metric | Pass | Marginal | Fail |
|--------|------|----------|------|
| HIBP hit rate | >= 5% | 2-5% | < 2% |
| New roots discovered | >= 50 | 20-50 | < 20 |
| Tier-1 discoveries (>=1K HIBP) | >= 5 | 1-5 | 0 |

### Decision Matrix
| Spanish Result | French Result | Action |
|---------------|---------------|--------|
| PASS | PASS | Full harvest both languages (25K+ candidates each) |
| PASS | MARGINAL | Full harvest Spanish, adjust French seeds/corpora |
| PASS | FAIL | Full harvest Spanish only, investigate French corpus quality |
| MARGINAL | PASS | Full harvest French, adjust Spanish seeds/corpora |
| MARGINAL | MARGINAL | Reassess approach — try OpenSubtitles for colloquial text |
| FAIL | FAIL | Abort multilingual Markov — invest in other approaches |

### Comparison Benchmark
Side-by-side with English Markov at equivalent query budget:
- English validation (from memory): ~40-44% for 2-word, ~10-12% for 3-word
- Spanish target: ~20-30% for 2-word, ~5-8% for 3-word (estimated)
- French target: ~25-35% for 2-word, ~7-10% for 3-word (higher due to AZERTY word-bias)

---

## Escalation: Full Harvest

If validation passes, run full harvest:
```bash
bun run scratchpad/markov-multilingual-harvest.ts --language spanish --mode harvest --budget 50000
bun run scratchpad/markov-multilingual-harvest.ts --language french --mode harvest --budget 50000
```

### Integration Pipeline
1. Discoveries → `data/cohorts/spanish-phrases.txt` / `data/cohorts/french-phrases.txt`
2. Rebuild nocap-plus.txt: `scripts/rebuild-nocap-plus.py`
3. Upload nocap-plus.txt to Hashtopolis: `bun Tools/FileUploader.ts --replace`
4. DiamondAnalyzer will auto-classify future diamonds into spanish-phrases / french-phrases cohorts
5. Include in batch-0008 attack plan

---

## Seed Words

### Spanish Super Seeds (18)
Emotional/functional words with highest expected transition density:
`amor, vida, te, mi, no, tu, el, la, es, yo, de, en, un, por, con, para, que, si`

### Spanish Strong Seeds (50)
Cultural/emotional/slang:
`dios, loco, rey, sol, luna, fuego, muerte, guerra, noche, dia, bueno, malo, grande, libre, corazon, casa, hola, papi, mami, chica, chico, negro, rojo, azul, oro, vamos, como, todo, siempre, nunca, bien, mucho, mundo, perro, gato, dulce, bonita, hermosa, linda, princesa, reina, sangre, soy, mas, solo, real, nuevo, puta, mierda, cabron`

### French Super Seeds (18)
Function words with rich transitions:
`je, tu, le, la, de, ne, un, mon, ma, pas, en, est, que, pour, avec, dans, sur, ce`

### French Strong Seeds (50)
Cultural/emotional:
`amour, vie, dieu, mort, roi, reine, coeur, soleil, nuit, jour, feu, noir, blanc, rouge, bleu, or, bon, beau, fou, petit, grand, libre, monde, maison, belle, cher, chat, chien, papa, maman, bonjour, salut, merci, merde, putain, jamais, toujours, tout, seul, ange, etoile, fleur, ciel, terre, mer, sang, guerre, paix, reve, doux`

---

## Tool Reference

| Tool | Purpose |
|------|---------|
| `scratchpad/markov-multilingual-harvest.ts` | Main harvest tool (--language, --mode, --budget) |
| `DiamondAnalyzer.ts` | Updated with spanish-phrases + french-phrases COHORT_PATTERNS |
| `data/cohorts/spanish-phrases.txt` | Spanish cohort file (populated after harvest) |
| `data/cohorts/french-phrases.txt` | French cohort file (populated after harvest) |
| `scripts/rebuild-nocap-plus.py` | Rebuild nocap-plus.txt after cohort changes |

---

## HIBP Query Budget

| Phase | Spanish | French | Total |
|-------|---------|--------|-------|
| Validation | 4,000 | 4,000 | 8,000 |
| Full Harvest (if passed) | 50,000 | 50,000 | 100,000 |
| **Maximum** | **54,000** | **54,000** | **108,000** |

---

## Risk Factors

1. **News corpus register**: Leipzig news text is more formal than tweets/movies. May produce grammatically correct but non-password-like phrases. Mitigation: Spanish tweets (248K) provide social media register balance.
2. **Accent stripping**: Spanish ñ→n, French é→e may create collisions with English words in baseline. Mitigation: Baseline filter catches these.
3. **Short function words as seeds**: "de", "la", "le" may produce too many common phrases already in baseline. Mitigation: Budget system stops spending on low-yield seeds.

---

*Created: 2026-02-11*
*Research basis: CrowdStrike 2025 LATAM Report, NordPass 2024 Country Data, Richelieu French Password Project, Leipzig Corpora Collection*
