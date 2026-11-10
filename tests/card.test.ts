// The sentence card's model (plan.md step 19): bead lookup, card status and neighbours, stepping, reveal scroll.
import { describe, expect, it } from 'vitest'
import { BeadIndex, revealDelta, sentenceCard, stepSentence, type CardBead } from '../src/reader/card.ts'

const bead = (de: number[], en: number[], confidence = 0.99): CardBead => ({ deSentenceIdx: de, enSentenceIdx: en, confidence })

// German 0..7 against English 0..7 (English 5 has no German sentence; German 6 no English one).
const beads: CardBead[] = [
  bead([0], [0]),
  bead([1, 2], [1], 0.95), // 2-1
  bead([3], [2, 3], 0.6), // 1-2, uncertain
  bead([4], [4]),
  bead([], [5]), // 0-1
  bead([5], [6], 0.7), // uncertain
  bead([6], []), // 1-0
  bead([7], [7]),
]
const index = new BeadIndex([...beads].reverse()) // order of the rows must not matter

describe('BeadIndex', () => {
  it('finds the bead of every German sentence and nothing for one outside every bead', () => {
    expect(index.beadOf(2)).toBe(beads[1])
    expect(index.beadOf(6)).toBe(beads[6])
    expect(index.beadOf(99)).toBeNull()
  })

  it('knows which sentences are in uncertain beads', () => {
    expect(index.isUncertain(3)).toBe(true)
    expect(index.isUncertain(1)).toBe(false)
    expect(index.isUncertain(99)).toBe(false)
    expect([...index.uncertainSentences()].sort()).toEqual([3, 5])
  })

  it('gives the English sentences around a bead, including ones aligned with no German', () => {
    expect(index.neighbours(beads[2])).toEqual({ before: 1, after: 4 })
    expect(index.neighbours(beads[3])).toEqual({ before: 3, after: 5 })
    expect(index.neighbours(beads[0])).toEqual({ before: null, after: 1 })
    expect(index.neighbours(beads[7])).toEqual({ before: 6, after: null })
  })

  it('finds the English text on either side of a sentence with no translation', () => {
    expect(index.neighbours(beads[6])).toEqual({ before: 6, after: 7 })
    const lonely = new BeadIndex([bead([0], [])])
    expect(lonely.neighbours(lonely.beadOf(0)!)).toEqual({ before: null, after: null })
  })
})

describe('sentenceCard', () => {
  it('highlights the whole bead and shows its translation', () => {
    expect(sentenceCard(index, 2)).toEqual({ highlight: [1, 2], translation: [1], status: 'aligned', before: null, after: null })
    expect(sentenceCard(index, 3)).toEqual({ highlight: [3], translation: [2, 3], status: 'uncertain', before: 1, after: 4 })
  })

  it('shows the neighbouring English text for an unmatched sentence', () => {
    expect(sentenceCard(index, 6)).toEqual({ highlight: [6], translation: [], status: 'unmatched', before: 6, after: 7 })
  })

  it('falls back to the sentence alone when it is in no bead', () => {
    expect(sentenceCard(index, 42)).toEqual({ highlight: [42], translation: [], status: 'unaligned', before: null, after: null })
  })
})

describe('stepSentence', () => {
  const chapter = [0, 1, 2, 3, 4, 5, 6, 7]

  it('steps to the next and previous sentence, treating a bead as one stop', () => {
    expect(stepSentence(index, chapter, 0, 1)).toBe(1)
    expect(stepSentence(index, chapter, 1, 1)).toBe(3)
    expect(stepSentence(index, chapter, 2, 1)).toBe(3)
    expect(stepSentence(index, chapter, 3, -1)).toBe(2)
    expect(stepSentence(index, chapter, 2, -1)).toBe(0)
  })

  it('stops at the ends of the chapter', () => {
    expect(stepSentence(index, chapter, 0, -1)).toBeNull()
    expect(stepSentence(index, chapter, 7, 1)).toBeNull()
    expect(stepSentence(index, [3, 4, 5], 5, 1)).toBeNull()
    expect(stepSentence(index, [3, 4, 5], 5, -1)).toBe(4)
  })

  it('steps over sentences in no bead one at a time and ignores an unknown start', () => {
    const none = new BeadIndex([])
    expect(stepSentence(none, [10, 11, 12], 11, 1)).toBe(12)
    expect(stepSentence(none, [10, 11, 12], 11, -1)).toBe(10)
    expect(stepSentence(index, chapter, 99, 1)).toBeNull()
  })
})

describe('revealDelta', () => {
  // Viewport 800, card 300, bar 60: the band is 72–488.
  it('leaves a sentence alone that already lies between the bar and the card', () => {
    expect(revealDelta(100, 140, 800, 300, 60)).toBe(0)
    expect(revealDelta(72, 488, 800, 300, 60)).toBe(0)
  })

  it('scrolls down just enough to lift a sentence above the card', () => {
    expect(revealDelta(600, 650, 800, 300, 60)).toBe(650 - 488)
    expect(revealDelta(450, 500, 800, 300, 60)).toBe(12)
  })

  it('scrolls up just enough to bring a sentence out from under the bar', () => {
    expect(revealDelta(-50, 20, 800, 300, 60)).toBe(-50 - 72)
    expect(revealDelta(60, 100, 800, 300, 60)).toBe(-12)
  })

  it('aligns a sentence taller than the band to its top, and gives up when there is no band', () => {
    expect(revealDelta(200, 900, 800, 300, 60)).toBe(200 - 72)
    expect(revealDelta(200, 300, 400, 380, 60)).toBe(0)
  })
})
