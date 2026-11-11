/** Host plugin entry for Talk to DeepSeek (`@whyself/ttds`). */
import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin identifier. */
export const name = 'ttds'

/**
 * Mount the TTDS host plugin lifecycle on the active Cordis context.
 * @param ctx - plugin context that owns every registered effect and listener.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    return () => {}
  })
}
