import { useCallback, useMemo, useState } from 'preact/hooks'
import { ImportError, importFile, type ImportedText } from '../import/file.ts'
import type { Lang } from '../import/types.ts'
import { requestPersistentStorage } from '../pwa/register.ts'
import { addBook } from '../store/books.ts'
import { BottomSheet } from '../ui/BottomSheet.tsx'
import { Cover } from '../ui/Cover.tsx'
import { coverColours } from '../ui/cover.ts'

interface Props {
  open: boolean
  onClose: () => void
}

const ACCEPT = '.txt,.epub,text/plain,application/epub+zip'

const LABELS: Record<Lang, string> = { de: 'Deutsch', en: 'English' }

interface Picked {
  file: File
  parsed: ImportedText | null
  error: string | null
  loading: boolean
}

/** The "Add book" sheet: two files, title and author (prefilled from EPUB metadata), cover preview. */
export function AddBookSheet({ open, onClose }: Props) {
  const [picked, setPicked] = useState<Partial<Record<Lang, Picked>>>({})
  const [titleEdit, setTitleEdit] = useState<string | null>(null)
  const [authorEdit, setAuthorEdit] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prefill from the German EPUB when present, else the English one. A field the user has
  // typed in keeps their text.
  const meta = picked.de?.parsed?.meta ?? picked.en?.parsed?.meta ?? null
  const title = titleEdit ?? meta?.title ?? ''
  const author = authorEdit ?? meta?.author ?? ''
  const colours = useMemo(() => coverColours(title), [title])

  const reset = useCallback(() => {
    setPicked({})
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

  const de = picked.de?.parsed ?? null
  const en = picked.en?.parsed ?? null
  const canSave = de !== null && en !== null && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await requestPersistentStorage()
      await addBook({ title, author, de, en })
      reset()
      onClose()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error && err.name === 'QuotaExceededError' ? 'Not enough storage space on this device.' : 'Could not save the book.')
      setSaving(false)
    }
  }

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
        {(['de', 'en'] as Lang[]).map((lang) => (
          <FileRow key={lang} lang={lang} picked={picked[lang]} onChange={onPick(lang)} />
        ))}
      </div>
      <p class="group-footer">Plain text (.txt) or EPUB. Chapters and sentences are matched after import.</p>

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
    const { words, paragraphs, sections } = picked.parsed
    detail = `${picked.file.name} · ${words.toLocaleString()} words, ${paragraphs.length.toLocaleString()} paragraphs`
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
