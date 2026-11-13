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

### Phase 8 — Account and sync
36. Google sign-in through Supabase (`supabase/README.md`); each book's reading place and
    bookmarks synced under its content key, last write wins per book, decided on the server.
    Books stay on the device. No Account group in a build without a project.
    **Check:** sign in from the installed app on the phone; read on the Mac, open the same
    book on the phone at the same place.

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
| 18 | Word card (step 24) | A tap on a word opens the bottom card in word mode (`reader/WordCard.tsx`, model in `reader/word.ts`): the word alone gets the page highlight (not its bead), the header shows it as printed, the body the dictionary's best headword in full: every entry of that lemma with the article(s) coloured by gender (der blue, die red, das green by default; "m/n" gives both, the plural-only "die" stays uncoloured), the lemma in the reading font, part of speech, plural, the glosses as a numbered list, then a line on how the word was reached when that is not obvious (separable verb with the particle, compound with each part's first gloss, a stem guess) and the sources; the other headwords follow as one-line alternatives (at most four) that switch the card to them; then the sentence with the word marked and "Show translation", which switches to the sentence card; then Bookmark (step 25) and Copy ("das Haus (noun, pl. Häuser): house, building; home"). The lookup runs through the shared `Dictionary` with the sentence and the word's offset, so separable verbs reunite; a later tap cancels an earlier result. A word the dictionary lacks shows "No entry" with the dictionary's state when that explains it (still downloading n%, waiting for a connection, failed); a shard that is neither cached nor fetchable shows why. Taps follow §1.6: a word opens the word card, punctuation, whitespace or the small chevron drawn after every sentence (`.sent::after`, faint, in the UI font) opens the sentence card; the long-press of step 20 is unchanged. Word spans carry their offset in the run (`data-o`), which is also how the active word is found again on a re-render. The colours are a setting (`store/settings.ts`, the `settings` table, read live with `useSetting` and sanitised on every read): Settings gets an Articles group with a row per article and ten swatches (the system colours plus Plain), the label drawn in its colour, and a Reset. Check: 30 random words of the Kafka fixture tapped in the browser, 30 resolved, 29 to a sensible first headword ("stellte … dar" → darstellen, "umwehten" → um + wehen, "im" → in); the one miss is "die", whose own lemma is FreeDict-only and so ranks after Wiktionary's "das" by the step 22 order. |
| 19 | Bookmarks from the card (step 25) | Bookmark on either card toggles: a tap saves, a second tap on the same bead or word removes, and the pill reads "Bookmarked" with a filled ribbon (`aria-pressed`) while the bookmark exists. A *sentence* bookmark is the bead the card showed (`bookmarks/model.ts`: its German sentence indices and English indices, both texts joined as they read, the chapter position and heading), so a tap on any sentence of a 2-1 bead finds the same bookmark; an unmatched or unaligned sentence is bookmarkable with an empty translation. A *word* bookmark is the word as tapped (sentence, offset, token) with the headword the card showed in full (lemma and its `EntryView`s: articles, part of speech, plural, glosses, source; null and empty when the dictionary had nothing), the sentence it appeared in and that sentence's translation; the button waits for the lookup to answer so the entry recorded is the one seen. Texts are copied into the payload rather than looked up again, so a bookmark survives a re-alignment and the export of step 27 needs only the row; the indices stay for step 26's jump. Rows live in the `bookmarks` table as declared since step 6b (`BookmarkRow` is now typed as a union on `type`), `note` empty for now; a book's bookmarks are loaded with one live query and matched in memory (`findSentenceBookmark`, `findWordBookmark`), nothing indexed beyond `bookId`. The top bar's ribbon stays disabled until the bookmarks screen (step 26). Checked in the browser on the Kafka fixture: a 1-2 bead and the word "Rücken" bookmarked, removed and re-added from the cards, the state following Previous / Next and the word → sentence switch. |
| 20 | Bookmarks screen (step 26) | One screen, `app/Bookmarks.tsx` at `#/bookmarks`, reached from a ribbon in the Library's top bar; the Reader's ribbon (enabled now) opens the same screen for its book alone at `#/bookmarks/<bookId>/<chapter>`, with Back returning to that chapter. Books-style grouped list (`bookmarks/list.ts`, DOM-free): a group per book with a cover thumbnail and count, groups in order of their newest bookmark, rows within a book in reading order (first sentence, then word offset); a sentence row shows the German text over its translation, a word row the headword with its article coloured as the word card colours it, the glosses and the sentence it came from; both end with the chapter heading and the day ("Today", "Yesterday", "9 Nov", with the year once it is not this year's). The search field matches every word of the query, case-, accent- and ß-insensitively, against both texts, headword, glosses, heading, title and author. Rows swipe to delete as in iOS lists (`ui/SwipeRow.tsx` over `ui/swipe.ts`: a drag uncovers an 88 px Delete that stretches past that, a release settles open or shut by position or flick, a drag across 60% of the row deletes outright; one row open at a time, a tap elsewhere shuts it; Delete / Backspace on a focused row uncovers it for the keyboard); the list is one live query, so it follows deletions and bookmarks made in the Reader. A tap jumps: the route becomes `#/read/<bookId>/<chapter>/<bookmarkId>`, and the Reader finds the bookmark in the text as it is now (`bookmarks/locate.ts`: the recorded sentence while its text still matches, else the same text nearest to it; a word at its offset, else by its text in the sentence, else the sentence alone), corrects the chapter should a re-alignment have moved it, scrolls the windowed page until the sentence is rendered and 15% down from the top bar, opens the sentence or word card on it, and replaces the route with the plain chapter so the jump happens once. The Reader's chapter-change reset must stand down while a jump is pending: when the bookmark's paragraph is among the first rendered, arrival and reset land in the same commit. Checked in the browser on the Kafka and Werther fixtures: bookmarks made from both cards, grouped and searched, swiped open and deleted with a real pointer drag, jumped to in chapters 2 and 3 with the card open on the sentence and on the word, in light and dark and at phone width. |
| 21 | Bookmark export (step 27) | From a share button in the bookmarks screen's top bar, a sheet with three formats (`bookmarks/export.ts`, DOM-free), each built from the bookmarks on screen, so a search or the per-book view narrows the file too; the file goes out through `shareOrDownload` of step 14 (the share sheet on iOS, a download elsewhere), named `bookmarks.<ext>` or `bookmarks-<title-slug>.<ext>` for one book. *JSON* is full fidelity: `{format: "interlinear-bookmarks", version: 1, exported, books: [{id, title, author, langs, bookmarks: [rows]}]}`, rows as stored minus `bookId`, so a later import can match the book by id (bundles keep ids across devices) or by title. *Markdown* is for reading: a heading per book, a sub-heading per chapter, the German in bold over its translation, a word as "**der Rücken** — glosses" over the sentence in italics and its translation. *Anki* is tab-separated text with Anki's `#separator:tab` and `#html:true` header (older importers skip `#` lines): one note per bookmark, front the German sentence or "der Rücken", back the translation or the glosses with the sentence and translation under `<br>`s; `&`, `<`, `>` are escaped, tabs and newlines flattened, and a field holding a quote is quoted CSV-style with inner quotes doubled, which Anki's reader unwraps. No import yet: the JSON is shaped for it. Checked in the browser on the Kafka fixture by intercepting the download: all three files, and a search narrowing the Anki file to one note. |
| 22 | aA menu (step 28) | Books' appearance popover from the top bar's aA button (`reader/AppearanceMenu.tsx` over the DOM-free `reader/appearance.ts`): a text-size stepper over 14–32 px (default 18, +2 px on wide screens as before), the five themes as discs (White, Sepia `#f8f1e3`/`#5b4636`, Gray `#4a4a4c`/`#ededed`, Night, Auto), three line spacings (1.35 / 1.55 / 1.8), a font list (Books' picker mapped to what iOS ships: Original = New York via `ui-serif`, Charter, Georgia, Iowan Old Style in Athelas's place since iOS has no Athelas, Palatino, San Francisco, Times New Roman, each name drawn in its face), and the Scroll / Paged switch §1.4 reserves, Paged disabled. One `settings` row (`appearance`, sanitized on read like the article colours); a change applies at once from local state so two quick taps on the stepper step twice, and is saved for the live query to confirm. The choice reaches the page as inline custom properties on the Reader's root: the reading font replaces `--font-serif` there, so the chapter heading and the cards' text take it too; `.reader-page` reads `--reader-size` and `--reader-leading`. Themes are a `data-theme` attribute on `<html>` while the Reader is mounted, removed when it leaves, so the Library and the other screens keep following the system. To make a forced theme win over the system, every colour token is now one `light-dark()` pair following `color-scheme` (`index.css`), and no stylesheet has a `prefers-color-scheme` query any more: White and Night pin the scheme, Sepia and Gray replace the tokens and pick the scheme their contrast matches so the highlight, swatches and sheets agree. A change that reflows the page keeps the place being read: before the windowed body rebuilds its height map it notes the paragraph at the viewport's top and how far into it, gives the top spacer its new height at once so the DOM agrees with the map, and scrolls back to the same depth into that paragraph. Checked in the browser on the Kafka fixture: every theme (White forced over a dark system, Auto following it, the attribute gone on Back), Georgia on page and card, the stepper deep in chapter one holding paragraph 14 at 41% of itself across two sizes down and four up, and the menu with its font list at phone width. |
| 23 | Library polish (step 29) | The Library opens with a "Reading Now" card for the aligned book opened most recently: cover, title, author, the chapter it is open at (its heading, else "Chapter n", nothing for a one-chapter book) and a progress line with "n% read" ("Just started" under 1%, "Finished" from 99.5%); a tap opens it where it was left. Under a "Library" heading the shelf grid follows, each opened book's tile carrying the same read share. Covers and the card link to `#/read/<bookId>` *without* a chapter, which now means "where it was last read" (`#/read/<bookId>/0` is chapter one, explicitly). The place is the `progress` table's row, one per book, rewritten on every change (`reader/progress.ts`): the chapter, the paragraph at the top of the viewport by position within the chapter and how far into it the viewport starts, the share of the book's text before that place (characters of the chapters only, so excluded front and back matter do not count; the whole chapter once its end is on screen), and the time. The windowed body reports the place after every scroll and render; the Reader writes it half a second after the last change and at once on `pagehide`, on the page going hidden and on leaving the screen, and ignores it while a bookmark jump or a restore is pending. Restoring runs through the body's jump path with no sentence: the page is scrolled to where the height map puts the paragraph, which renders and measures it, then the viewport's top edge is put the stored fraction into it (the chapter's top, heading and all, for paragraph 0 at 0). A route with an explicit chapter restores only when it is the stored chapter; otherwise the chapter opens at its top. A tile swipes left (`ui/SwipeRow.tsx` of step 26, given a `plain` mode whose content keeps its own link and buttons and an `ask` mode, its motion styles now in `ui/swipe.css`) to uncover a 72 px Delete, which asks in a sheet naming the bookmarks that go with the book; confirmed, the alignment job is cancelled, the tile shrinks away and `deleteBook` removes every row. Tiles clip what slides out of them, so they reach into the grid gaps by negative margins padded back for the cover's shadow, and the grid aligns tiles to their start so a shorter tile never shows the Delete column beneath its content. Checked in the browser on the Kafka fixture: a scroll deep into chapter one saved paragraph 14 at 98% of itself and the card read "I." and "12% read"; a tap on the card landed on the same paragraph at the same fraction; Next chapter and a reload on `/1` kept the place while a reload on `/0` opened at the top; the end of chapter III read "Finished"; a bookmark jump still landed under the top bar; and a throwaway book was swiped open with a real drag, confirmed and gone with its two bookmarks, at desktop and phone width. |
| 24 | Launch screens, safe areas, no bounce (step 31) | iOS shows a blank white page while an installed web app loads unless the document lists a PNG per device as `apple-touch-startup-image`, so `tools/pwa-splash.ts` lists 22 portrait screens (iPhone SE through 17 Pro Max and Air, every iPad size) and `npm run icons` (now `tools/make-icons.ts`, the same dependency-free PNG encoder) paints each in a light and a dark variant: the app icon, rounded at iOS's 22.37% radius and antialiased, about a quarter of a phone's width and capped at 128 pt on an iPad, centred on white or black (937 KB for 44 files, committed under `public/splash/`). The links are injected into `index.html` by the PWA plugin from the same list, with both schemes spelled out in the media query so exactly one matches per device whichever way iOS orders them; the service worker leaves them alone, since iOS copies them at install time. Safe areas were already variables in `index.css`; Settings' content now clears the home indicator too. Rubber-band: `overscroll-behavior: none` on the page stays, and since Safari honours it only in part, `pwa/overscroll-guard.ts` (over the DOM-free `pwa/overscroll.ts`) cancels the first `touchmove` of a vertical pan when nothing under the finger can scroll the way it asks, walking the scroll containers from the target out to the page and stopping at one that does not chain (`overscroll-behavior: contain`, the card body and sheets), so a pull past the top or push past the bottom never starts a bounce while a pan a card body or the page can take goes through; horizontal pans and moves the browser already owns (`cancelable` false) are left alone. The reader's top bar and footer get `touch-action: none`, so a finger on them never scrolls the page beneath. And a pinned reading theme now reaches Safari's toolbars: `pwa/theme-color.ts` sets both `theme-color` metas to the page's computed background while `<html data-theme>` is set and restores the light/dark pair when it goes. |
| 25 | Language check at import (first part of step 33) | The Add Book sheet guesses each picked file's language (`import/language.ts`, DOM-free): the EPUB package code when it is German or English, else a tally of thirty common function words of each language over the first 20,000 characters, decided only when the winner has twenty hits and twice the other's, so an odd text gets no warning rather than a wrong one. Two files in each other's slots (the Demian of 2026-11-10 on the live site, read as English ever since) get a red footer with a Swap button and no Save until swapped; one file in the other language gets a warning and Save stays, since the guess can be wrong. The rest of step 33 (bad EPUB, empty files, quota, dictionary missing) is still to do. |
| 26 | Performance pass (step 32) | Lighthouse 13 has no PWA category any more (it went in 12), so the mark is its four, mobile preset against `vite preview` on the Library with an empty shelf: performance 100 / accessibility 100 / best practices 100 / SEO 100 (from 100 / 87 / 100 / 91), FCP 0.8 s and LCP 1.6 s under its simulated slow 4G and 4× CPU slowdown, the same on a second run in the same profile with the service worker in place. What changed: the main chunk was 72% unused on the Library, so the Reader is a lazy route (`lazy` + `Suspense` in `app.tsx`; its own JS and CSS chunk, loaded when a book opens) and JSZip is imported inside `parseEpub` on the first EPUB, which took the shell from 381 KB / 125 KB gzipped of script and 36 KB of CSS to 234 KB / 80 KB and 20 KB; `shellFiles` in `tools/pwa-sw.ts` now follows dynamic imports too, stopping at the chunks `isPrecachable` rules out, so both chunks are precached and a book opens and an EPUB imports offline from the first launch on. The dictionary installer told its listeners about every one of the ~560 shards, and the hook re-renders the whole app, so `setProgress` now notifies at most every 250 ms (phase changes still at once): that was most of the main thread's work on a first launch. Accessibility: `maximum-scale=1, user-scalable=no` left the viewport meta (iOS Safari ignored it anyway, `touch-action: manipulation` on the body already stops the double-tap zoom, and pinch zoom in an installed app is the reader's right), and the primary button's text is black on Books' orange, white having read at 2:1. SEO: `public/robots.txt`, since the preview answered `/robots.txt` with the page. And `<meta name="color-scheme" content="light dark">`, so the first paint before the stylesheet follows the system scheme. First paint under 1 s on an iPhone is not measured here (no device in this session): the shell is one document, one stylesheet and two scripts from the service worker's cache, 81 KB gzipped of script to parse before the Library renders. Checked in the browser on the production build: a txt pair added, aligned and opened with the Reader chunk and its CSS fetched on the way, the word card styled, an EPUB built in the page parsed through the lazy JSZip, and the dictionary re-downloaded with the footer updating a few times a second instead of per shard. |
| 27 | Account and sync (step 36) | The app is a static site with no server, so "sign in" is a question of where the state goes: Supabase, with Google as the provider, through a full-page OAuth redirect with PKCE (the flow that works inside an installed iOS web app, where popups do not) and PostgREST over `fetch`, in a hand-written client of four endpoints (`src/sync/supabase.ts`) rather than supabase-js: the app holds only the public anon key, and `supabase/schema.sql` keeps every account to its own rows with row-level security. What syncs is the reading state alone: one `reading_state` row per user and book, keyed by the SHA-256 of both texts (`sync/key.ts`, stored on the book the first time it is needed) so a re-import anywhere finds its place; the books themselves, large and the reader's own files, stay on the device. Last write wins per book on the whole state (place and bookmarks together): every local write stamps the book's `sync` row (`store/sync.ts`, a new Dexie table in schema version 2; the stamp only grows, so a change after a pull beats what was pulled whatever the clocks say), the engine (`sync/engine.ts`) pushes the stamped books a few seconds after the last change and pulls on launch, online and when the app is shown again: stamps of every row first, then the rows newer than here, then the books newer here. A `before update` trigger drops an upsert whose stamp is not newer, so two devices cannot lose the newer state. The Account group sits first in Settings: Sign in with Google, else the picture, name and the sync's state, Sync Now and Sign Out; a build without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` has no group and starts nothing. Deleting a book leaves its row for a later import; signing out keeps the state here and forgets the pushes, so the next account is sent everything. Not verified in this session: the redirect round trip on a real phone, and against a real project, since none existed yet; the client and engine are tested against fakes of GoTrue and PostgREST. |

## 5. Build order

Phases as numbered in §3, but Phase 4 (dictionary) runs right after Phase 1, because the
aligner's lexical scoring needs it: **0 → 1 → 4 → 2 → 3 → 5 → 6 → 7**. First thing to do is
step 1 (scaffold) in this folder.
