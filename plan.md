# Interlinear Reader — Plan

A static, offline-first web app (PWA) for reading a German book with its English translation
side by side. Tap a sentence → English. Tap a word → article / gender / meaning. No network calls
at read time; everything (book, alignment, dictionary, bookmarks) lives on the device.
Styled as a replica of Apple Books. Installable from Safari via Share → Add to Home Screen.

> All design choices below were confirmed on 2026-11-09. See §4 for the decisions log.

---

## 0. Constraints that shape everything

- **No API calls.** Translation and dictionary lookups must come from data already on the device.
  → Sentence translation = the uploaded English text, aligned to the German text on-device.
  → Word meaning = a dictionary bundled with the site and cached by the service worker.
- **Add to Home Screen** on iOS requires HTTPS, a web manifest, `apple-mobile-web-app-capable`,
  an `apple-touch-icon`, and a service worker for offline. Static hosting is enough.
- **iOS storage.** Books (MB) and the dictionary (tens of MB) go in IndexedDB / Cache Storage,
  not localStorage. Request `navigator.storage.persist()` so Safari doesn't evict data.

---

## 1. Design decisions

### 1.1 Input files — **DECIDED: txt + epub**
- Accept **.txt** (UTF-8) and **.epub** for each language. EPUB is unzipped client-side
  (JSZip), spine items become chapters, HTML stripped to paragraphs and headings.
- No PDF (text extraction is unreliable).

**Primary test pair: Hesse, *Demian* (already in `Input/`).**
Two EPUBs: the German original (Calibre conversion, 47k words, 11 spine items) and the Penguin
Classics 2013 English edition (Damion Searls translation, 60k words, 20 spine items). This is the
real-world case the app is for, and it is harder than any clean Gutenberg pair:

| | German EPUB | English EPUB |
|---|---|---|
| Front matter | title page with epigraph | copyright, contents, Franco foreword (828 w), **Freedman introduction (6,204 w — longer than most chapters)**, further-reading list, epigraph |
| Prologue | `index_split_001` (506 w) | `EPUB-6-3` (578 w) |
| Chapters | `index_split_002…009`, 8 chapters, 2.7k–7.5k words | `EPUB-7…14`, 8 chapters, consistently ≈1.1× the German |
| Headings | `<p class="calibre5">Zwei Welten</p>` — no `<h*>` | `<p class="x03-Chapter-Number">CHAPTER ONE</p>` + `<p class="x03-Chapter-Title">TWO WORLDS</p>` — no `<h*>` |
| Quirks | Calibre splits paragraphs across `<span>`s mid-word ("Vorbi</span><span>ld"); trailing spaces | endnote `<sup>` anchors in the intro; `<em>` inside sentences; curly quotes and em-dashes |

What this forces into the design (now in §1.1b and §1.2 Layer A): front-matter detection so the
6k-word introduction is not aligned against Chapter 1; heading detection from short unpunctuated
leading paragraphs and "CHAPTER ONE" patterns, not `<h*>` tags; spine-to-spine chapter matching
by lexical overlap of names (Sinclair, Demian, Kromer, Pistorius), not only by length; and
inline-tag flattening before sentence splitting.

The app does no licensing or DRM checks of any kind: whatever two files you import, it parses,
aligns and reads. `Input/` stays in the repo as the Demian test pair.

**Additional fixtures (Project Gutenberg, plain text, in `tests/fixtures/`):**
1. **Kafka, *Die Verwandlung* / *Metamorphosis* (tr. David Wyllie).** Short (~20k words), long
   sentences, little dialogue. Fast to iterate on; Wyllie follows Kafka's sentence structure
   closely, so this is the "easy" pair and the first to pass.
2. **Goethe, *Die Leiden des jungen Werther* / *The Sorrows of Young Werther* (tr. R. D. Boylan).**
   Epistolary with dated letter headings (natural anchors), 19th-century translation that merges
   and splits sentences freely and occasionally drops clauses. This is the "hard" pair.
   Backup: Kafka, *Der Prozess* / *The Trial* (tr. Wyllie) — longer, with dialogue.

For each pair, hand-check the first ~150 sentence beads once and save them as a gold file
(`tests/fixtures/<book>.gold.json`). The smoke test (Phase 7) asserts bead accuracy against all
three gold files, so any change to the aligner is measured, not eyeballed. Gutenberg headers/footers are stripped during fixture preparation.

### 1.1b EPUB import realities (learned from Demian)
- **Flatten inline markup first.** Concatenate text across `<span>`, `<em>`, `<i>`, `<b>`, `<a>`
  inside a block; drop `<sup>` endnote markers and `<img>`; only block elements (`p`, `div` with
  no block children, `h*`, `li`, `blockquote`) start a paragraph. Collapse whitespace, normalise
  curly quotes/dashes only for *matching*, never for display.
- **Section detection per spine item**, in this order:
  1. Class-name hints when present (`*Chapter-Number*`, `*Chapter-Title*`, `*FM-*` = front matter,
     `*BM-*` = back matter) — cheap wins on publisher EPUBs.
  2. Heading heuristic: leading paragraph(s) under ~60 characters with no terminal punctuation,
     or matching `CHAPTER \w+`, `Kapitel \d+`, roman numerals, or ALL CAPS.
  3. Front/back-matter heuristic: spine items whose text contains copyright / ISBN / "Contents" /
     "Foreword" / "Introduction" / "Further Reading" / "Inhalt" / "Impressum", or whose
     proper-noun and year density is far above the book's median (essays about the author).
- **Chapter mapping across editions** (§1.2 Layer A): DP over spine items of both books with
  a score combining relative length and overlap of capitalised tokens (character names survive
  translation). Front-matter items may map to nothing. Result: an ordered list of chapter pairs
  plus unmatched sections.
- **Fully automatic — no confirmation step.** Import runs straight through to alignment. To make
  that safe without a gate:
  1. The chapter-mapping DP uses *both* signals (length ratio and name overlap), and a section is
     only excluded as front/back matter when the matter heuristic *and* a poor DP match agree.
  2. The mapping gets a confidence score. If a section pair scores badly, it is still aligned
     (never dropped silently) but shown with a subtle marker in the reader's chapter list.
  3. The chapter list sheet (already part of the Books chrome) lists every section of both
     editions, including excluded ones, so a wrong guess is visible and reversible from there:
     include/exclude a section or re-pair two chapters, and alignment re-runs for that chapter
     only. This is a fix-after-the-fact affordance, not a step in the import flow.
  4. The debug view and the gold files for Demian (the one book with heavy front matter) keep
     the heuristics honest as they evolve.

### 1.2 Sentence alignment (on-device, no API) — **DECIDED: layered classical, neural later**
Two translations of a book rarely have the same sentence count, so alignment is the hardest piece.
Goal: good enough that manual repair is almost never needed. Four layers, each narrowing the
search space for the next. All run in a Web Worker at import time, once per book.

**Layer A — Structure anchors (hard constraints).**
- Sections are detected per §1.1b, front and back matter excluded, and chapters matched across
  the two editions automatically by length + name-overlap DP. Chapter pairs are pinned 1-1 and
  alignment never crosses them. For plain-text input the same heading
  heuristics run on lines ("Kapitel 3", "Chapter 3", roman numerals, standalone numbers).
- Paragraph alignment inside each chapter by dynamic programming over paragraph lengths, with
  1-1, 1-2, 2-1, 1-0, 0-1 moves. Translators keep paragraphs far more faithfully than sentences.

**Layer B — Sentence splitting.** Abbreviation-aware (German: "z.B.", "usw.", "Dr.", "Nr.",
ordinals like "3."; English: "Mr.", "e.g.", "etc."), quote- and dash-aware (German „…“ and »…«),
ellipsis-aware. Unit-tested on tricky cases.

**Layer C — Hunalign-style scoring (the main engine).** Within each aligned paragraph block,
dynamic programming over sentence beads (1-1, 1-2, 2-1, 1-0, 0-1, 2-2) with a combined score:
1. *Length* — Gale–Church character-length log-likelihood (German ≈ 1.1× English chars).
2. *Lexical overlap* — using the **shipped dictionary** as a bilingual lexicon: lemmatise each
   German token via the inflection index, look up its English glosses, count matches against the
   English sentence's tokens (stemmed). Score = Dice coefficient of translation hits. This is what
   turns a length heuristic into a real aligner.
3. *Cognates & identical tokens* — numbers, proper nouns (capitalised tokens not sentence-initial),
   and character-5-gram cognates (Mutter/mother, Haus/house, Nation/nation) score as matches
   even when the dictionary is silent.
4. *Punctuation shape* — question marks, exclamation marks, dialogue quotes, colons: a small bonus
   when both sentences share the same terminal shape.
5. **Second pass with a book-specific lexicon.** Take the confident 1-1 beads from pass one,
   compute word co-occurrence (Dice over the aligned pairs) to learn translations the dictionary
   missed (character names, the translator's habitual renderings), add them to the lexicon, and
   realign. This is Hunalign's trick and typically fixes most residual errors.
6. Every bead gets a **confidence** (margin between the best and second-best path through it).

**Layer D — Optional neural alignment (Bertalign-style), off by default.**
A multilingual sentence-embedding model (`paraphrase-multilingual-MiniLM-L12-v2`, int8 ONNX,
≈120 MB one-time download) run locally via transformers.js / ONNX Runtime Web. Embeds both
sides, aligns by cosine similarity + DP. Still no API call, but it is a big download and takes
minutes on an iPhone for a novel, so it is a per-book "Re-align with high accuracy" button,
most useful when run on a Mac/iPad. It only *re-scores* Layer C's candidate beads, so it cannot
make things worse structurally.

**Fallbacks & escape hatches.**
- Low-confidence beads get a hairline dotted underline in the reader; tapping shows the two
  neighbouring English sentences too, so you still get the meaning even when the bead is off by one.
- Repair UI (long-press → merge / split / shift) exists but is the last resort, and a repair
  re-runs Layer C locally for the rest of that paragraph so one fix cascades.
- Aligned books can be **exported as a bundle** (`.interlinear.json`) and imported on another
  device, so a heavy Layer D alignment done on a Mac can be AirDropped to the phone.
- Pre-aligned input (one sentence per line, equal counts) is also accepted and skips alignment.

**Acceptance target.** Against the gold files (§1.1): ≥97% bead accuracy on Kafka, ≥95% on
Demian, ≥93% on Werther after Layer C pass two, so repairs are rare.

### 1.3 Dictionary source & size — **DECIDED: both**
- Build-time script compiles **Wiktionary (kaikki.org German extract)** into a compact lookup:
  `lemma → { pos, gender/article, plural, top 3 English glosses }` plus an
  `inflected form → lemma` index (so "Häusern" → "Haus", "ging" → "gehen"). Estimated 25–40 MB
  gzipped, sharded by first two letters so only the shards you touch are fetched, then cached
  offline by the service worker.
- **FreeDict deu-eng** (~5 MB) merged in as a fallback for lemmas Wiktionary lacks, and as extra
  glosses where Wiktionary's are thin. Entries are tagged with their source.
- The merged dictionary doubles as the bilingual lexicon for alignment Layer C (§1.2), so the
  alignment worker needs the whole thing locally: the full dictionary is downloaded and cached on
  first install (background, with progress in Settings), not just shards on demand.
- Lookup order when a word is tapped: exact form → lowercase → inflection index → compound split
  (greedy longest-suffix match for German compounds, e.g. "Haustür" → "Haus" + "Tür") →
  separable-verb reunion (sentence contains "fing … an" → "anfangen") → "no entry".

### 1.4 Reading layout — **DECIDED: vertical scroll**
- Vertical scroll with Apple Books chrome (top bar fades on scroll, thin progress line at bottom,
  "n pages left in this chapter" computed from viewport height). Paged mode is out of scope for v1;
  the aA menu reserves the toggle for later.

### 1.5 How the translation appears — **DECIDED: bottom card**
- Tapping a German sentence gives it Books' soft highlight and slides up a **bottom card**
  (Apple Books "Look Up" style: rounded top corners, frosted background, grabber). The card shows
  the English sentence(s) in the reading font, the chapter name, and actions: Bookmark, Copy,
  Previous / Next sentence (arrows advance the highlight without closing the card, so you can
  step through a passage), and a low-confidence note with neighbouring sentences when relevant.
- Swipe down or tap outside to dismiss. The page never reflows.

### 1.6 Word popover
- Tap a word → the same bottom card, in **word mode**: headword with article
  (**der / die / das** coloured by gender), part of speech, plural form, English meanings, source
  tag, and the sentence it came from. "Bookmark" and "Copy" buttons. A "Show sentence translation"
  link switches the card to sentence mode.
- Disambiguating taps: single tap on a word = word card; tap on the small chevron at the end of
  each sentence, or on inter-word whitespace, = sentence card. (Alternative for later: tap =
  sentence, long-press = word; configurable in Settings.)

### 1.7 Bookmarks — **DECIDED: sentences + words; JSON / Markdown / Anki TSV export**
- Bookmark **sentences** (German + aligned English + chapter + position) and **words**
  (headword + article + gloss + the sentence it appeared in).
- Bookmarks view: Apple Books–style list grouped by book, searchable, swipe to delete.
- Export: **JSON** (full fidelity, re-importable), **Markdown** (readable), and **TSV for Anki**
  (`German<TAB>English`). Export uses the Web Share API on iOS (share sheet) with download fallback.

### 1.8 Aesthetic: Apple Books replica
- Fonts: `"New York", "Iowan Old Style", "Palatino", Georgia, serif` for body; SF via
  `-apple-system` for UI. Books' font picker (Original, Athelas, Charter, Georgia, Palatino,
  San Francisco, Times New Roman) mapped to what iOS actually has installed.
- Themes: White, Sepia (`#f8f1e3` / `#5b4636`), Gray, Night (`#000` / `#ccc`), Auto by system.
- Controls: "aA" menu (font, size, theme, line spacing, scroll/paged toggle), bookmark ribbon,
  chapter list, progress line ("12 pages left in this chapter").
- Library: bookshelf grid with generated covers (title + author on a gradient), like Books'
  "Reading Now" / "Library" tabs.
- Motion: iOS-like spring transitions; safe-area aware; no rubber-band on chrome.

### 1.9 Tech stack — **DECIDED: Vite + Preact + TypeScript**
- Vite + TypeScript + Preact (tiny, fast, JSX for the UI), hand-written CSS (no Tailwind — easier
  to pixel-match Books). Dexie.js over IndexedDB. JSZip for EPUB. Hand-rolled service worker.
  Vitest for unit tests.
- Build-time tools: a Node script (`tools/build-dict`) to compile and shard the dictionary.

### 1.10 Hosting — **DECIDED: GitHub Pages**
- GitHub Pages (free HTTPS static host). A GitHub Actions workflow builds on push to `main`.
  Dictionary shards are produced in CI from the kaikki and FreeDict downloads and cached between
  runs, so they are not committed to the repo.

---

## 2. Architecture

```
src/
  app/            routing (Library, Reader, Bookmarks, Settings)
  import/         txt + epub parsing → Paragraph[] per language
  align/          sentence splitter, paragraph DTW, Gale–Church, repair ops
  dict/           shard loader, lemmatizer, compound splitter, lookup()
  reader/         rendering, tap handling, interlinear expansion, word card
  bookmarks/      store, list view, export (json/md/tsv)
  store/          Dexie schema: books, alignments, bookmarks, settings, progress
  pwa/            manifest, service worker, install hint ("Share → Add to Home Screen")
  ui/             Books-styled components: TopBar, BottomSheet (forms), BottomCard (reading), aA menu, Shelf
tools/
  build-dict/     downloads kaikki JSONL → shards in public/dict/
public/
  dict/           aa.json.gz … zz.json.gz + index.json
  icons/          apple-touch-icon 180, 192, 512; splash
```

Data model (IndexedDB via Dexie):
- `books`: id, title, author, lang pair, created, cover colours
- `paragraphs`: bookId, lang, idx, text
- `sentences`: bookId, lang, paraIdx, idx, text, charStart, charEnd
- `beads`: bookId, beadIdx, deSentenceIds[], enSentenceIds[], manual: bool
- `bookmarks`: id, bookId, type (sentence|word), payload, note, created
- `progress`: bookId, sentenceId, scrollFraction
- `settings`: theme, font, size, layout

---

## 3. Executable steps

Each step ends in something you can open in a browser and check.

### Phase 0 — Scaffold (½ day)
1. `npm create vite@latest interlinear -- --template preact-ts`; add Dexie, JSZip, vitest.
2. Set up `index.html` with manifest, `apple-mobile-web-app-capable`, `apple-touch-icon`,
   `viewport-fit=cover`, status-bar style. Add basic service worker (precache app shell).
3. GitHub repo + Pages workflow (`actions/deploy-pages`). Verify Add to Home Screen opens
   a standalone window on an iPhone.
   **Check:** blank app installs to Home Screen and opens full-screen offline.

### Phase 1 — Import (1 day)
4. `import/txt.ts`: normalise line endings, split paragraphs on blank lines, strip BOM.
5. `import/epub.ts`: unzip, parse `container.xml` → OPF → spine, flatten inline markup per
   §1.1b, emit one Section per spine item with paragraphs and detected heading / kind
   (front, body, back). Unit-test on the two Demian EPUBs in `Input/`.
5b. `import/sections.ts`: heading and front-matter heuristics; chapter-mapping DP across the two
   books. **Check:** on Demian, Foreword / Introduction / Further Reading are unmatched, prologue
   ↔ prologue, 8 chapters ↔ 8 chapters.
5c. Mapping confidence score; low-confidence pairs and excluded sections surface in the reader's
    chapter list (Phase 3, step 17) with include/exclude and re-pair actions that re-align that
    chapter only. No import-time confirmation.
6. Fixtures: `tools/fetch-fixtures` downloads the two Gutenberg pairs into `tests/fixtures/`,
   strips boilerplate; commit them alongside the Demian EPUBs.
6b. Library screen: "Add book" sheet with two file inputs (Deutsch / English), title/author fields
   (prefilled from EPUB metadata), generated cover. Persist to Dexie.
   **Check:** upload the Demian pair, see it on the shelf, reload offline, still there.

### Phase 2 — Alignment (3–4 days; depends on Phase 4's dictionary build for Layer C)
7. `align/structure.ts`: chapter/heading detection; paragraph DP with 1-1/1-2/2-1/1-0/0-1 moves.
8. `align/sentences.ts`: sentence splitter with German/English abbreviation lists, quote and
   dash handling; unit tests on tricky cases.
9. `align/features.ts`: length score, lexical-overlap score via dictionary + lemmatiser,
   cognate/number/proper-noun score, punctuation-shape score.
10. `align/beads.ts`: DP over 1-1, 1-2, 2-1, 1-0, 0-1, 2-2 beads with the combined score;
    confidence = best-vs-second-best margin.
11. `align/lexicon.ts`: pass two — induce a book-specific lexicon from confident beads, realign.
12. Run the pipeline in a Web Worker on import; progress bar on the cover; results into Dexie.
13. Alignment debug view (dev only): two columns, coloured beads, confidence heat. Use it to
    hand-check the first ~150 beads of each pair and save them as gold files; then tune feature
    weights against the gold score: Kafka first, then Demian (the real target), then Werther.
14. Bundle export/import (`.interlinear.json`) and pre-aligned input path.
    **Check:** ≥97% bead accuracy on Kafka, ≥95% on Demian, ≥93% on Werther after pass two.
    Demian (~3,500 sentences per side) aligns in under 10 s on an iPhone.
15. *(Later, optional)* `align/neural.ts`: transformers.js + int8 MiniLM; "Re-align with high
    accuracy" button; model cached by the service worker after first download.

### Phase 3 — Reader core (2 days)
16. Reader screen: chapters rendered as paragraphs → sentences → words (`<span>` per word,
    tokenised preserving punctuation and whitespace). Virtualise long chapters.
17. Books chrome: top bar (back, title, aA, search, bookmark ribbon) that hides on scroll,
    bottom progress line, chapter list sheet. The chapter list shows the section mapping of both
    editions (excluded front matter greyed, low-confidence pairs marked) with include/exclude
    and re-pair actions.
18. Bottom card component (shared by sentence and word modes): frosted background, grabber,
    swipe-to-dismiss, spring animation, safe-area aware.
19. Sentence tap → highlight + card in sentence mode with prev/next stepping and low-confidence
    neighbours.
20. Alignment repair (last resort): long-press sentence → "Fix alignment" (merge next / split /
    shift); re-run Layer C for the rest of the paragraph; persist.
    **Check:** read a chapter on iPhone; taps feel right; corrections persist.

### Phase 4 — Dictionary (2 days; build this before Phase 2's Layer C)
21. `tools/build-dict`: download kaikki German JSONL and FreeDict deu-eng; keep nouns/verbs/adj/
    adv/prep/etc.; merge (Wiktionary primary, FreeDict fills gaps); emit
    `{lemma, pos, gender, plural, glosses[], src}` and `forms → lemma` index; shard by first two
    letters; gzip; write `index.json` with shard sizes and a version hash.
22. `dict/lookup.ts`: normalise (ß/ss, case, trailing punctuation) → exact → inflection index →
    compound split → separable-verb reunion; in-memory LRU over shards in Cache Storage.
23. First-run background download of the whole dictionary (needed by the aligner), with progress
    in Settings and a "dictionary ready" state; subsequent loads are offline.
24. Word tap → card in word mode: headword, **article coloured by gender** (der blue, die red,
    das green — configurable), pos, plural, glosses, source, "Bookmark", "Copy". Graceful "no entry".
    **Check:** tap 30 random words in the test book; ≥85% resolve to a sensible entry.

### Phase 5 — Bookmarks & export (1 day)
25. Bookmark sentence and word from the card.
26. Bookmarks screen: grouped by book, search, swipe-to-delete, tap to jump to location.
27. Export: JSON / Markdown / Anki TSV; `navigator.share({ files })` on iOS, `<a download>` fallback.
    **Check:** export → open on Mac → import TSV into Anki.

### Phase 6 — Apple Books polish (1–2 days)
28. aA menu: font family, size stepper, line spacing, themes (White / Sepia / Gray / Night / Auto).
29. Library polish: shelf grid, "Reading Now" card with progress, swipe to delete book.
30. Install hint banner for Safari ("Share → Add to Home Screen") shown once when not standalone.
31. Splash screens / icons; safe-area insets; prevent rubber-band overscroll on chrome.
32. Performance pass: Lighthouse PWA ≥ 90; first paint < 1 s on iPhone.
    **Check:** side-by-side with Apple Books on the same device, same book: looks like the same app.

### Phase 7 — Hardening
33. Error states: bad EPUB, mismatched books, empty files, storage quota exceeded, dictionary
    not yet downloaded.
34. Unit tests for splitter, alignment features, lookup; a smoke test that imports and aligns a
    fixture pair and asserts bead accuracy against a hand-checked gold alignment.
35. README: how to build the dictionary, how to deploy, how to install on iPhone.

---

## 4. Decisions log

| # | Topic | Decision |
|---|-------|----------|
| 1 | Alignment | Layered: structure anchors → Hunalign-style length + dictionary lexical scoring → book-specific lexicon second pass; optional neural re-align; repair UI as last resort |
| 2 | Dictionary | Wiktionary extract + FreeDict merged; full download on first run (also feeds the aligner) |
| 3 | Translation display | Bottom card (Books "Look Up" style), page never reflows |
| 4 | Layout | Vertical scroll; paged out of scope for v1 |
| 5 | Input formats | txt + epub, any source, no licensing checks; Demian EPUBs in `Input/` are the primary test pair, Gutenberg pairs secondary |
| 5b | Chapter mapping | Fully automatic, no import-time confirmation; corrections possible later from the chapter list |
| 6 | Stack | Vite + Preact + TypeScript, hand-written CSS, Dexie, JSZip, Vitest |
| 7 | Hosting | GitHub Pages via Actions; dictionary built in CI |
| 8 | Bookmarks & export | Sentences + words; JSON + Markdown + Anki TSV via share sheet |
| 9 | Neural re-align (step 15) | `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, int8, via transformers.js on the WASM backend, in the same alignment worker as Layer C; it adds one semantic feature to the bead DP rather than replacing it. The model weights are kept in Cache Storage by transformers.js itself (`transformers-cache`), which also works before the service worker is active and in dev; the ONNX runtime's `.wasm` is served from our own origin and cached by the service worker on first use. A failed re-align leaves the previous alignment in place. |
| 10 | Reader rendering (step 16) | One chapter per screen, the original text only; paragraphs cut into sentence runs along the stored `charStart`/`charEnd` and words tokenised with a Unicode letter/digit regex (apostrophes and hyphens allowed inside), punctuation and whitespace kept as plain text so the page is lossless. Long chapters are windowed by hand (`reader/virtual.ts`): heights estimated from length until measured, spacers for the rest, manual scroll correction instead of the browser's anchoring. A book that is not aligned yet opens as one chapter without sentence spans. |
| 11 | Books chrome and chapter edits (step 17) | Fixed top bar (back, contents, title, aA, search, bookmark; the last three are disabled until steps 25 and 28) and footer (progress line, "n pages left in this chapter"), both sliding away on a downward scroll past a small threshold and back on an upward one (`reader/chrome.ts`). The chapter sheet lists every section of both editions as pair rows, excluded front/back matter greyed in place; two-sided pairs carry a length-agreement confidence (shorter side over longer, in units of each side's median chapter) and are marked at or below 0.7. Corrections are `ChapterEdits` on the book, keyed by spine index (EPUB) or first-paragraph index (txt): include/exclude a section, pin a pair by hand (the DP pairs the free chapters, the lists are merged in reading order). An edit re-aligns only the chapter pairs whose paragraph ranges changed (`reuse` by `pairKey`), with the stored lexicon and, for a neural book, the model; `mergeAlignment` splices new beads among the kept ones and refuses if the sentence rows differ. Excluded sections are not shown in the reader. |
| 12 | Bottom card (step 18) | One component, `ui/BottomCard.tsx`, for the sentence and word cards: Books' Look Up look (frosted, rounded top, grabber), bottom-anchored and padded for the home indicator, extending 40 px below the screen so a spring overshoot shows no gap. Non-modal, unlike the form sheets of `ui/BottomSheet.tsx`: no backdrop, the page stays visible and scrollable and never reflows; a tap on the page dismisses it (told from a scroll by pointer travel), the Reader can instead turn a tap on another sentence into a switch (`onOutsideTap`). Dismissed also by swiping it down or Escape. Motion is a damped spring (`ui/motion.ts`, stiffness 300, damping 30) sampled into Web Animations keyframes, so a drag's release velocity flows into the return or the exit; upward drags are rubber-banded; a release past 40% of the height or a downward flick dismisses. Reduced motion skips the springs. The card reports its height (`onHeightChange`) so step 19 can keep the tapped sentence above it. |
| 13 | Sentence card (step 19) | A tap on a German sentence is about its *bead*: the whole bead (1–3 sentences) gets Books’ soft yellow highlight, the card shows the bead’s English side joined in the reading font under the chapter name, between Previous / Next arrows (also ← / →) that move the highlight through the chapter one bead at a time without closing the card; Copy puts "German\nEnglish" on the clipboard, Bookmark waits for step 25. The model is DOM-free (`reader/card.ts`: `BeadIndex`, `sentenceCard`, `stepSentence`, `revealDelta`). Beads at or below `LOW_CONFIDENCE` (0.8) are *uncertain*: their sentences carry a faint dotted underline on the page, and the card shows the English sentences just before and after the match greyed around it with a note, since a near-tie in the DP usually means the translation runs one sentence to either side; a 1-0 bead shows those neighbours in place of a translation. The page scrolls just enough (smoothly, unless reduced motion) to keep the highlighted sentence between the top bar and the card, using the height the card reports. English sentence texts and beads are loaded with the book in the reader’s live query, so stepping is instant and a re-alignment refreshes the card. |
| 14 | Alignment repair (step 20) | Long-press a sentence (a right-click, or "Fix alignment" on the sentence card) and the bottom card switches to repair mode (`reader/RepairCard.tsx`): the bead's German side, the English sentences around its match (neighbours greyed), and the actions Shift ← / →, Merge ← / →, Split, Reset, each saved at once. A repair *pins* the bead (`manual: true`, confidence 1); older pins stay unless the new one shares a sentence with them (newest wins); then Layer C runs again over the free sentences between the pins of that paragraph block, so one fix cascades through the rest of the paragraph (`align/repair.ts`). Split re-aligns the bead's own sentences with the DP capped at one sentence a side (`AlignOptions.maxSize`) and pins the pieces. Blocks are not stored, so they are recovered from the beads (paragraphs joined by a bead form a block; `BlockIndex`); the DP runs on the main thread with the book's stored lexicon and ratio, classically even for a neural book (the model is not loaded for a tap). Persisting rewrites the beads from the block's first `beadIdx` on, renumbered, after checking the stored block is the one the repair started from, and refreshes the stats. Pins survive chapter edits of other chapters (`mergeAlignment` keeps them) but not a full re-alignment. Sentences get `user-select: none` and no iOS callout so the long-press is ours; Copy on the card covers copying. |
| 15 | Dictionary build (step 21) | `tools/build-dict` (`npm run dict`) streams two sources into `public/dict/`: the kaikki.org English-Wiktionary extract of German (95 MB gzipped JSONL, 372k lines, primary) and FreeDict deu-eng 1.9 (the Ding dictionary as TEI, a 17 MB `.tar.xz` unpacked with `tar`), both cached under `node_modules/.cache/interlinear-dict` (`.dict-cache` in CI). A Wiktionary line of a kept part of speech becomes an entry `{lemma, pos, gender, plural, glosses[], src}`: gender from the sense tags or the headline ("m/n" when several, "pl" for plural-only), up to three glosses taken one per sense, the most general gloss of each sense that is not a label or pointer first ("depiction, image, picture", not the sub-sense "digital photograph"), usual senses before obsolete/archaic/dated/rare/regional ones, which are kept, not dropped, because the books are old; then specific sub-senses while slots are left. Its one-word table forms (the subordinate-clause row gives "anfing" → anfangen; two-word forms, diminutives and gendered counterparts such as "Schreierin" are not forms) and the form-of / alt-of lines of other words make the inflection index; links to lemmas the dictionary lacks are dropped. FreeDict then fills gaps: one-word headwords only ("sich " stripped from verbs; a headword with a number but no part of speech is one of Ding's plural entries, a noun; neither → `other`), new words tagged `freedict`, glosses appended to thin Wiktionary entries (`wikt+freedict`), never a gender changed. Format in `src/dict/format.ts`, shared with step 22: `forms` keys are folded (lowercase, ß → ss, umlauts kept) and map to lemmas, `entries` are keyed by the exact lemma ("Weg" and "weg" apart); a form lives in the shard of its own two-letter ASCII-folded prefix and an entry in its lemma's, so a lookup needs at most two shards ("Häusern" and "Haus" share `ha`; "ging" and "gehen" do not). Result: 561 shards, 9.9 MB gzipped (not the 25–40 MB guessed in §1.3: Wiktionary has 93k German lemmas with English glosses, most of its 372k lines being inflected forms), 319k lemmas, 330k entries, 654k forms, the largest shard (`sc`) 0.4 MB; `index.json` lists shard sizes and a content hash as the version. The build takes under a minute from cached downloads, runs in CI keyed by the tool's hash, and is never committed. |
| 16 | Dictionary lookup (step 22) | `src/dict/lookup.ts` is DOM-free and reads shards through an injected loader; `src/dict/shards.ts` is the browser side: the index and shards live in their own Cache Storage cache, `interlinear-dict`, not the service worker's shell cache (which is replaced on every app update; the worker now leaves `dict/` requests alone), each shard keyed by its URL plus the dictionary version as a query so shards of two builds never mix; `index.json` is read from the cache when present (offline open, no round trip) and `DictStore.refresh()` fetches a new one and drops the old version's shards when the version changed. Step 23 fills the same cache. In front of it a `ShardCache` LRU keeps 24 decoded shards in memory and shares concurrent loads; `decodeShard` (in `format.ts`) sniffs the gzip magic bytes, since Vite serves `.json.gz` already decoded and GitHub Pages does not. `Dictionary.lookup(token, {sentence, offset})` follows §1.3: normalise (NFC, surrounding quotes/punctuation and soft hyphens stripped; candidates: the word, without a clitic 's, a separable zu-infinitive without its "zu", a hyphenated compound joined and then its head) → the folded form in the index, which covers exact, case, ß/ss and inflected forms at once → a stem guess by stripping common endings (uncertain, for FreeDict words that have no forms) → compound split (longest known head whose remainder is known, with linking elements s/es/n/en/er/e/ens, up to four parts, recursive; modifiers read as nouns when they can be, the head as a noun or not by the word's own capital: Reisemuster → Reise+Muster, hinaufzukriechen → hinauf+kriechen) → separable-verb reunion from the sentence: a particle at the end of the clause after the tapped verb (end of sentence, before punctuation, or before "zu"; a particle before a noun phrase, "ging nach Hause", is a preposition) is prepended and looked up (fing … an → anfing → anfangen), and a tapped particle finds the clause's finite verb reading the clause from its start, since German puts it second ("sah … an" is ansehen even though "lange" is a form of langen). Headwords are ranked for the card: capitalisation agreement first (a lowercase word is never a noun: "linke" is the adjective, not die Linke; a capitalised word inside a sentence is one, a sentence-opening capital says nothing), then content words before names/abbreviations ("Häusern" is houses before the municipality) before FreeDict's part-less `other` entries (FreeDict lists inflected forms as headwords: "sah: viewed"), Wiktionary before FreeDict-only, then a reunited verb, the exact spelling, a case match, an inflected form; all headwords are returned so the card can offer the alternatives. Probe over 120 words of the Kafka fixture against the real shards: 120 resolved, 88 exact, 25 inflected, 135 shard loads, 1.5 s in Node. |
| 17 | Dictionary download (step 23) | The whole dictionary is fetched into the `interlinear-dict` cache on first run, in the background, a second after the shell paints (`src/dict/installer.ts` over the platform-free `src/dict/download.ts`): the missing shards in index order, four at a time, progress by the gzipped sizes `index.json` records, three attempts per shard with growing pauses. There is nothing to record for a resume: a shard is cached or it is not, so an interrupted run continues where it stopped on the next launch, and a launch after the first costs one `cache.keys()` and shows *ready* before any request. Going offline aborts the run and leaves the state *waiting*; the `online` event starts it again, and Settings opening or Retry does too. Online, every run also fetches the current `index.json` (`DictStore.refresh`): a new version is adopted by the shared store and `Dictionary` (`adoptDictStore`), the old shards dropped, and the download starts over for the new ones while the old version keeps answering. Settings is a new screen at `#/settings` (gear in the Library's top bar): a Dictionary group with the state row (Checking / Downloading n% · a of b MB with a progress line / Waiting for a connection / Couldn't download with Retry / Ready · 10.4 MB on this device), the sources and build date, and Check for Updates; the Library's status line shows `Dictionary 43%` / `Dictionary ready`. `dictionaryReady()` is the aligner's precondition for using the dictionary as its Layer C lexicon, which is not wired yet (the pipeline still runs on length, cognates and the induced lexicon). On localhost the 561 shards take 3.4 s; a mid-run offline/online left 318 of 562 cache entries and resumed to 562 without refetching them. |

## 5. Build order

Phases as numbered in §3, but Phase 4 (dictionary) runs right after Phase 1, because the
aligner's lexical scoring needs it: **0 → 1 → 4 → 2 → 3 → 5 → 6 → 7**. First thing to do is
step 1 (scaffold) in this folder.
