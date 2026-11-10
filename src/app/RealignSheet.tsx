import { useEffect, useState } from 'preact/hooks'
import { startAlignment } from '../align/jobs.ts'
import { deleteModelCache, modelCacheStatus, type ModelCacheStatus } from '../align/neural-cache.ts'
import { MODEL_DOWNLOAD_MB } from '../align/neural.ts'
import type { Book } from '../store/db.ts'
import { BottomSheet } from '../ui/BottomSheet.tsx'

interface Props {
  /** The book to re-align; `null` keeps the sheet closed. */
  book: Book | null
  onClose: () => void
}

/**
 * "Re-align with high accuracy" (plan.md step 15): explains what the language model does and
 * costs, shows whether it is already on this device, and starts the neural job. The model can
 * be removed from here too, since 120 MB is worth a button on a phone.
 */
export function RealignSheet({ book, onClose }: Props) {
  const open = book !== null
  const [model, setModel] = useState<ModelCacheStatus | null>(null)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    setModel(null)
    void modelCacheStatus().then((status) => {
      if (live) setModel(status)
    })
    return () => {
      live = false
    }
  }, [open])

  if (book === null) return null
  const alreadyNeural = book.alignment?.stats?.neural === true

  let modelDetail: string
  if (model === null) modelDetail = 'Checking…'
  else if (model.cached) modelDetail = model.bytes > 0 ? `On this device · ${Math.round(model.bytes / 1e6)} MB` : 'On this device'
  else modelDetail = `${MODEL_DOWNLOAD_MB} MB download, kept on this device`

  const start = () => {
    void startAlignment(book.id, { neural: true })
    onClose()
  }

  const remove = async () => {
    setRemoving(true)
    try {
      await deleteModelCache()
    } catch (err) {
      console.error(err)
    }
    setModel(await modelCacheStatus())
    setRemoving(false)
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Re-align with High Accuracy">
      <p class="sheet-text">
        A multilingual language model reads every sentence of both editions and re-scores how they match. Chapters and paragraphs stay as they
        are; sentence matches that length and vocabulary left uncertain are decided by meaning.
      </p>
      <p class="sheet-text">
        Everything runs on this device. A novel takes a few minutes on a Mac or iPad and much longer on a phone, so the quickest route is to
        re-align there and export the book as a bundle.
      </p>

      <div class="group">
        <div class="row row--static">
          <span class="row-label">Model</span>
          <span class="row-detail">{modelDetail}</span>
          {model?.cached ? (
            <button type="button" class="row-remove" disabled={removing} onClick={remove}>
              {removing ? 'Removing…' : 'Remove'}
            </button>
          ) : (
            <span />
          )}
        </div>
      </div>
      <p class="group-footer">
        {alreadyNeural
          ? 'This book was already aligned with the model; re-aligning gives the same result unless the model has changed.'
          : model?.cached
            ? 'Works offline.'
            : 'Needs an internet connection the first time; afterwards it works offline.'}
      </p>

      <button type="button" class="btn-primary" onClick={start}>
        Re-align
      </button>
      <button type="button" class="btn-plain" onClick={onClose}>
        Cancel
      </button>
    </BottomSheet>
  )
}
