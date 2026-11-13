import type { ComponentChildren } from 'preact'
import { useCallback, useMemo, useState } from 'preact/hooks'
import { needsAlignment, startAlignment } from '../align/jobs.ts'
import { isPrealignedPair } from '../align/prealigned.ts'
import { ImportError, importFile, type ImportedText } from '../import/file.ts'
import { guessLanguage, languageMismatch } from '../import/language.ts'
import type { Lang } from '../import/types.ts'
import { requestPersistentStorage } from '../pwa/register.ts'
import { addBook } from '../store/books.ts'
import { syncActive, syncNow } from '../sync/browser.ts'
import { BundleError, importBundle, parseBundle, type Bundle } from '../store/bundle.ts'
import { BottomSheet } from '../ui/BottomSheet.tsx'
import { Cover } from '../ui/Cover.tsx'
import { coverColours } from '../ui/cover.ts'

interface Props {
  open: boolean
  onClose: () => void
}

const ACCEPT = '.txt,.epub,text/plain,application/epub+zip'
const ACCEPT_BUNDLE = '.json,application/json'

const LABELS: Record<Lang, string> = { de: 'Deutsch', en: 'English' }

interface Picked {
  file: File
  parsed: ImportedText | null
  error: string | null
  loading: boolean
}

interface PickedBundle {
  file: File
  parsed: Bundle | null
  error: string | null
  loading: boolean
}

/**
 * The "Add book" sheet: two files, title and author (prefilled from EPUB metadata), cover
 * preview. A `.interlinear.json` bundle exported from another device (plan.md step 14) takes
 * the place of the two files and brings its alignment along; two plain-text files with one
 * sentence per line and equal line counts are pre-aligned input and skip the aligner too.
 * Each file's language is guessed (`import/language.ts`): two files in each other's slots get a
 * Swap button and no Save until swapped; one file in the wrong language gets a warning.
 */
export function AddBookSheet({ open, onClose }: Props) {
  const [picked, setPicked] = useState<Partial<Record<Lang, Picked>>>({})
  const [bundle, setBundle] = useState<PickedBundle | null>(null)
  const [titleEdit, setTitleEdit] = useState<string | null>(null)
  const [authorEdit, setAuthorEdit] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prefill from the bundle, else the German EPUB, else the English one. A field the user has
  // typed in keeps their text.
  const meta = bundle?.parsed?.book ?? picked.de?.parsed?.meta ?? picked.en?.parsed?.meta ?? null
  const title = titleEdit ?? meta?.title ?? ''
  const author = authorEdit ?? meta?.author ?? ''
  const colours = useMemo(() => coverColours(title), [title])

  const reset = useCallback(() => {
    setPicked({})
    setBundle(null)
    setTitleEdit(null)
    setAuthorEdit(null)
    setSaving(false)
    setError(null)
  }, [])

  const close = useCallback(() => {
    if (saving) return
    reset()
    onClose()
  }, [saving, reset, onClose])

  const onPick = (lang: Lang) => async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    setError(null)
    setPicked((p) => ({ ...p, [lang]: { file, parsed: null, error: null, loading: true } }))
    try {
      const parsed = await importFile(file)
      setPicked((p) => ({ ...p, [lang]: { file, parsed, error: null, loading: false } }))
    } catch (err) {
      const message = err instanceof ImportError ? err.message : `Could not read "${file.name}"`
      console.error(err)
      setPicked((p) => ({ ...p, [lang]: { file, parsed: null, error: message, loading: false } }))
    }
  }

  const onPickBundle = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    setError(null)
    setBundle({ file, parsed: null, error: null, loading: true })
    try {
      const parsed = parseBundle(await file.text())
      setBundle({ file, parsed, error: null, loading: false })
    } catch (err) {
      const message = err instanceof BundleError ? err.message : `Could not read "${file.name}"`
      console.error(err)
      setBundle({ file, parsed: null, error: message, loading: false })
    }
  }

  const de = picked.de?.parsed ?? null
  const en = picked.en?.parsed ?? null
  const prealigned = de !== null && en !== null && isPrealignedPair(de, en)
  const mismatch = useMemo(() => languageMismatch(de === null ? null : guessLanguage(de), en === null ? null : guessLanguage(en)), [de, en])
  const swap = () => setPicked((p) => ({ de: p.en, en: p.de }))
  const canSave = !saving && (bundle !== null ? bundle.parsed !== null : de !== null && en !== null && mismatch !== 'swapped')

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await requestPersistentStorage()
      const book = bundle?.parsed ? await importBundle(bundle.parsed, { title, author }) : await addBook({ title, author, de: de!, en: en! })
      // Alignment runs in the background; the cover shows its progress. A bundle brings its
      // alignment along, and pre-aligned text is beaded line by line inside the queue.
      if (needsAlignment(book)) void startAlignment(book.id)
      // The same book read on another device has its place on the server (step 36).
      if (syncActive()) void syncNow()
      reset()
      onClose()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error && err.name === 'QuotaExceededError' ? 'Not enough storage space on this device.' : 'Could not save the book.')
      setSaving(false)
    }
  }

  let footer: ComponentChildren
  let footerClass = 'group-footer'
  if (bundle !== null) footer = 'A bundle holds both texts and their alignment, so the book is ready to read at once.'
  else if (mismatch === 'swapped') {
    footerClass += ' group-footer--warn'
    footer = (
      <>
        These files look the other way round: the German one is English and the English one German.{' '}
        <button type="button" class="link-btn" onClick={swap}>
          Swap them
        </button>
      </>
    )
  } else if (mismatch !== null) {
    footerClass += ' group-footer--warn'
    footer = `The ${LABELS[mismatch]} file looks like ${mismatch === 'de' ? 'English' : 'German'}. Check it is the right one before adding.`
  } else if (prealigned) footer = `Both files have one sentence per line and ${de.paragraphs.length.toLocaleString()} lines: they will be matched line by line, without alignment.`
  else footer = 'Plain text (.txt) or EPUB. Chapters and sentences are matched after import.'

  return (
    <BottomSheet open={open} onClose={close} title="Add Book">
      <div class="add-preview">
        <Cover title={title} author={author} colours={colours} class="cover-preview" />
        <div class="add-fields">
          <label class="field">
            <span class="field-label">Title</span>
            <input
              type="text"
              value={title}
              placeholder="Title"
              autocomplete="off"
              onInput={(e) => setTitleEdit((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span class="field-label">Author</span>
            <input
              type="text"
              value={author}
              placeholder="Author"
              autocomplete="off"
              onInput={(e) => setAuthorEdit((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </div>
      </div>

      <div class="group">
        {bundle !== null ? (
          <BundleRow picked={bundle} onRemove={() => setBundle(null)} />
        ) : (
          (['de', 'en'] as Lang[]).map((lang) => <FileRow key={lang} lang={lang} picked={picked[lang]} onChange={onPick(lang)} />)
        )}
      </div>
      <p class={footerClass} role={mismatch === null ? undefined : 'alert'}>
        {footer}
      </p>

      {bundle === null && (
        <>
          <div class="group">
            <label class="row" for="file-bundle">
              <span class="row-label">Bundle</span>
              <span class="row-detail">Import an .interlinear.json file from another device</span>
              <span class="row-chevron" aria-hidden="true">
                ›
              </span>
              <input id="file-bundle" type="file" accept={ACCEPT_BUNDLE} class="visually-hidden" onChange={onPickBundle} />
            </label>
          </div>
          <p class="group-footer">Export a book from the shelf to make one.</p>
        </>
      )}

      {error && <p class="form-error" role="alert">{error}</p>}

      <button type="button" class="btn-primary" disabled={!canSave} onClick={save}>
        {saving ? 'Saving…' : 'Add to Library'}
      </button>
      <button type="button" class="btn-plain" disabled={saving} onClick={close}>
        Cancel
      </button>
    </BottomSheet>
  )
}

function FileRow({ lang, picked, onChange }: { lang: Lang; picked: Picked | undefined; onChange: (e: Event) => void }) {
  const id = `file-${lang}`
  let detail: string
  let cls = ''
  if (!picked) detail = 'Choose file'
  else if (picked.loading) detail = 'Reading…'
  else if (picked.error) {
    detail = picked.error
    cls = 'is-error'
  } else if (picked.parsed) {
    const { words, paragraphs, sections, layout } = picked.parsed
    const unit = layout === 'lines' ? 'lines' : 'paragraphs'
    detail = `${picked.file.name} · ${words.toLocaleString()} words, ${paragraphs.length.toLocaleString()} ${unit}`
    if (sections.length > 0) detail += `, ${sections.length} sections`
  } else detail = picked.file.name

  return (
    <label class={`row ${cls}`} for={id}>
      <span class="row-label">{LABELS[lang]}</span>
      <span class="row-detail">{detail}</span>
      <span class="row-chevron" aria-hidden="true">
        ›
      </span>
      <input id={id} type="file" accept={ACCEPT} class="visually-hidden" onChange={onChange} />
    </label>
  )
}

function BundleRow({ picked, onRemove }: { picked: PickedBundle; onRemove: () => void }) {
  let detail: string
  let cls = ''
  if (picked.loading) detail = 'Reading…'
  else if (picked.error) {
    detail = picked.error
    cls = 'is-error'
  } else if (picked.parsed) {
    const { book, beads } = picked.parsed
    const words = book.sources.de.words + book.sources.en.words
    detail = `${picked.file.name} · ${words.toLocaleString()} words`
    detail += beads.length > 0 ? `, ${beads.length.toLocaleString()} aligned sentences` : ', not aligned yet'
  } else detail = picked.file.name

  return (
    <div class={`row ${cls}`}>
      <span class="row-label">Bundle</span>
      <span class="row-detail">{detail}</span>
      <button type="button" class="row-remove" onClick={onRemove} aria-label="Remove bundle">
        Remove
      </button>
    </div>
  )
}
