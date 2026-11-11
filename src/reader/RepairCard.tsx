/**
 * The bottom card's content in repair mode (plan.md step 20): what a long-press on a German
 * sentence (or "Fix alignment" on the sentence card) opens. The header names the mode and has a
 * Done button back to the sentence card; the body shows the bead's German side, the English
 * sentences around its English side (the match itself in full colour, its neighbours greyed, so
 * a shift's effect is visible before it is made), and the actions of `align/repair.ts`: shift
 * the translation one sentence either way, merge with the previous or next sentence, split into
 * single sentences, and reset a bead fixed by hand. Every action is applied and saved at once;
 * the Reader's live query then redraws the card from the new beads. The Reader owns the state
 * and the writes; this component only draws a {@link BeadDescription}.
 */

import type { BeadDescription, RepairOp } from '../align/repair.ts'
import type { Lang } from '../import/types.ts'

interface HeaderProps {
  /** Back to the sentence card. */
  onDone: () => void
}

export function RepairCardHeader({ onDone }: HeaderProps) {
  return (
    <div class="card-nav card-nav--repair">
      <h2 class="card-title">Fix alignment</h2>
      <button type="button" class="card-done" onClick={onDone}>
        Done
      </button>
    </div>
  )
}

interface BodyProps {
  /** The bead under repair; null while the sentence is in no block (nothing to repair). */
  description: BeadDescription | null
  /** Languages of the original and the translation, for `lang` attributes. */
  langs: [Lang, Lang]
  /** Text of a German / English sentence by id. */
  text: { de: (idx: number) => string | undefined; en: (idx: number) => string | undefined }
  /** Apply an operation; the Reader persists it. */
  onRepair: (op: RepairOp) => void
  /** A write is in flight: the actions are disabled. */
  busy: boolean
  /** Why the last operation failed, if it did. */
  error: string | null
}

export function RepairCardBody({ description, langs, text, onRepair, busy, error }: BodyProps) {
  if (description === null) {
    return <p class="card-note card-note--lead">This sentence is not aligned with the translation, so there is nothing to fix.</p>
  }
  const { bead, before, after, options } = description
  const original = bead.deSentenceIdx.map(text.de).filter((t): t is string => t !== undefined)
  const translation = bead.enSentenceIdx.map(text.en).filter((t): t is string => t !== undefined)
  const beforeText = before === null ? undefined : text.en(before)
  const afterText = after === null ? undefined : text.en(after)
  const action = (label: string, title: string, enabled: boolean, op: RepairOp) => (
    <button type="button" class="card-action card-action--repair" title={title} aria-label={title} disabled={busy || !enabled} onClick={() => onRepair(op)}>
      {label}
    </button>
  )
  return (
    <>
      <p class="repair-original" lang={langs[0]}>
        {original.join(' ')}
      </p>
      <ol class="repair-rows" lang={langs[1]} aria-label="Translation">
        {beforeText !== undefined && <li class="repair-row repair-row--context">{beforeText}</li>}
        <li class={translation.length === 0 ? 'repair-row repair-row--bead repair-row--empty' : 'repair-row repair-row--bead'} aria-current="true">
          {translation.length === 0 ? 'No translation' : translation.join(' ')}
        </li>
        {afterText !== undefined && <li class="repair-row repair-row--context">{afterText}</li>}
      </ol>
      <div class="card-actions card-actions--repair">
        {action('← Shift', 'Translation one sentence earlier', options.shiftEarlier, { kind: 'shift', by: -1 })}
        {action('Shift →', 'Translation one sentence later', options.shiftLater, { kind: 'shift', by: 1 })}
        {action('Split', 'Split into single sentences', options.split, { kind: 'split' })}
        {action('← Merge', 'Merge with the previous sentence', options.mergePrevious, { kind: 'merge', dir: -1 })}
        {action('Merge →', 'Merge with the next sentence', options.mergeNext, { kind: 'merge', dir: 1 })}
        {action('Reset', 'Undo the fix and align this sentence automatically', options.reset, { kind: 'reset' })}
      </div>
      {error !== null ? (
        <p class="card-note card-note--error" role="alert">
          {error}
        </p>
      ) : (
        <p class="card-note">
          {busy ? 'Saving…' : bead.manual ? 'Fixed by hand. ' : ''}
          {busy ? '' : 'The rest of the paragraph is re-aligned around your fix.'}
        </p>
      )}
    </>
  )
}
