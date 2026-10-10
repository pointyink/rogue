// @ts-check
// Shared test utilities.
import { buildRope } from './dom_rope.js'

/**
 * buildRope that asserts a non-null result. Tests always build from non-empty
 * content, so the nullable return (null only on an empty element) is just noise
 * at the call site — this throws instead, and hands back a non-null rope.
 * @param {HTMLElement} element
 * @returns {NonNullable<ReturnType<typeof buildRope>>}
 */
export function mustBuildRope(element) {
  const rope = buildRope(element)
  if (!rope) throw new Error('mustBuildRope: element produced an empty rope')
  return rope
}
