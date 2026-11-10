/**
 * Motion arithmetic for the bottom card (plan.md step 18), kept apart from the DOM so it can be
 * tested: a damped spring sampled into keyframes, the rubber band that resists dragging the card
 * the wrong way, the velocity a drag was released with, and whether that release dismisses.
 *
 * Distances are in px, times in ms, velocities in px/ms throughout.
 */

export interface SpringOptions {
  /** Spring constant, in 1/s². */
  stiffness?: number
  /** Damping coefficient, in 1/s. The defaults give ζ ≈ 0.87: a hint of overshoot, like iOS sheets. */
  damping?: number
  mass?: number
  /** Interval between the samples returned; one 60 Hz frame by default. */
  step?: number
  /** The spring is at rest once this close to the target… */
  restDistance?: number
  /** …and this slow. */
  restVelocity?: number
  /** A spring that has not settled by then is cut to the target. */
  maxDuration?: number
}

export interface SpringTrack {
  /** Positions at `step` intervals: the start first, exactly the target last. */
  values: number[]
  /** `(values.length - 1) * step`. */
  duration: number
}

/** The card's spring: quick, with a touch of give. */
export const CARD_SPRING: SpringOptions = { stiffness: 300, damping: 30, mass: 1 }

/**
 * Sample a damped spring from `from` to `to`, starting at `velocity`, until it rests. Semi-implicit
 * Euler in sixteen sub-steps per sample is accurate and stable for the stiffness range of UI motion.
 */
export function spring(from: number, to: number, velocity: number, options: SpringOptions = {}): SpringTrack {
  const k = options.stiffness ?? CARD_SPRING.stiffness!
  const c = options.damping ?? CARD_SPRING.damping!
  const m = options.mass ?? CARD_SPRING.mass!
  const step = options.step ?? 1000 / 60
  const restDistance = options.restDistance ?? 0.5
  const restVelocity = options.restVelocity ?? 0.05
  const maxDuration = options.maxDuration ?? 2000

  const values = [from]
  let x = from - to
  let v = velocity * 1000 // px/s for the integrator
  if (Math.abs(x) < restDistance && Math.abs(v) < restVelocity * 1000) return { values: [to], duration: 0 }

  const substeps = 16
  const dt = step / substeps / 1000 // s
  let t = 0
  for (;;) {
    for (let i = 0; i < substeps; i++) {
      const a = (-k * x - c * v) / m
      v += a * dt
      x += v * dt
    }
    t += step
    if (t >= maxDuration || (Math.abs(x) < restDistance && Math.abs(v) < restVelocity * 1000)) {
      values.push(to)
      break
    }
    values.push(to + x)
  }
  return { values, duration: (values.length - 1) * step }
}

/**
 * iOS-style rubber band: the first px of `distance` count almost fully (slope `coefficient`),
 * further ones ever less, and the result never reaches `limit`.
 */
export function rubberBand(distance: number, limit: number, coefficient = 0.55): number {
  if (distance <= 0) return 0
  return (limit * distance * coefficient) / (distance * coefficient + limit)
}

/** Where the card sits after a finger moved `dy` from where it took hold: downward it follows, upward it resists. */
export function dragOffset(dy: number, limit = 40): number {
  return dy >= 0 ? dy : -rubberBand(-dy, limit)
}

export interface Sample {
  /** ms */
  t: number
  /** px */
  y: number
}

/**
 * The velocity at the end of a pointer track, in px/ms: the average over the last `window` ms
 * (a longer average would remember a pause before the flick). Zero when there is nothing to average.
 */
export function velocityOf(samples: readonly Sample[], window = 100): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  let first = last
  for (let i = samples.length - 2; i >= 0 && last.t - samples[i].t <= window; i--) first = samples[i]
  const dt = last.t - first.t
  return dt <= 0 ? 0 : (last.y - first.y) / dt
}

export interface DismissOptions {
  /** A downward release at least this fast dismisses wherever the card is. */
  flick?: number
  /** An upward release at least this fast keeps the card wherever it is. */
  recover?: number
  /** Otherwise the card goes once dragged down by this share of its height. */
  fraction?: number
}

/** Whether letting go of the card, `offset` px down and moving at `velocity`, dismisses it or snaps it back. */
export function shouldDismiss(offset: number, velocity: number, height: number, options: DismissOptions = {}): boolean {
  const flick = options.flick ?? 0.5
  const recover = options.recover ?? 0.3
  const fraction = options.fraction ?? 0.4
  if (velocity >= flick) return offset > 0
  if (velocity <= -recover) return false
  return offset > height * fraction
}
