// @ts-check
import { describe, it, expect } from 'vitest'
import { nodeSpan } from './sync.js'
import { buildRope } from './dom_rope.js'
import { mustBuildRope } from './test-helpers.js'

/** @param {string} html */
function el(html) {
  const d = document.createElement('div')
  d.innerHTML = html
  document.body.appendChild(d) // attach so node.isConnected is meaningful
  return d
}

/**
 * @param {NonNullable<ReturnType<typeof buildRope>>} rope
 * @param {Node} n
 * @returns {[number, number]}
 */
function range(rope, n) {
  const r = rope.getRange(n)
  if (!r) throw new Error('node not tracked in rope')
  return r
}

describe('nodeSpan', () => {
  it('a tracked node contributes its own rope range', () => {
    const root = el('<p>aa</p><p>bb</p>')
    const rope = mustBuildRope(root)
    const p0 = root.children[0]
    const r = range(rope, p0)
    expect(nodeSpan(rope, p0)).toEqual({ minIx: r[0], maxIx: r[1] })
  })

  it('a new (untracked) node between two tracked nodes spans both neighbours', () => {
    const root = el('<p>aa</p><p>bb</p>')
    const rope = mustBuildRope(root)
    const [p0, p1] = root.children
    const fresh = document.createElement('p')
    fresh.textContent = 'cc'
    root.insertBefore(fresh, p1) // p0, fresh, p1
    expect(nodeSpan(rope, fresh)).toEqual({
      minIx: range(rope, p0)[0],
      maxIx: range(rope, p1)[1],
    })
  })

  it('a new node at the front runs to the start edge', () => {
    const root = el('<p>aa</p><p>bb</p>')
    const rope = mustBuildRope(root)
    const p0 = root.children[0]
    const fresh = document.createElement('p')
    fresh.textContent = 'zz'
    root.insertBefore(fresh, p0) // fresh, p0, p1
    expect(nodeSpan(rope, fresh)).toEqual({
      startEdge: true,
      maxIx: range(rope, p0)[1],
    })
  })

  it('a new node at the back runs to the end edge', () => {
    const root = el('<p>aa</p><p>bb</p>')
    const rope = mustBuildRope(root)
    const p1 = root.children[1]
    const fresh = document.createElement('p')
    fresh.textContent = 'zz'
    root.appendChild(fresh) // p0, p1, fresh
    expect(nodeSpan(rope, fresh)).toEqual({
      minIx: range(rope, p1)[0],
      endEdge: true,
    })
  })

  it('a detached node contributes nothing (its removal is bracketed elsewhere)', () => {
    const root = el('<p>aa</p><p>bb</p>')
    const rope = mustBuildRope(root)
    const p0 = root.children[0]
    p0.remove() // tracked in the snapshot, but no longer connected
    expect(nodeSpan(rope, p0)).toEqual({})
  })

  it('a new node whose only neighbours are also new walks past them to the edges', () => {
    const root = el('<p>aa</p>')
    const rope = mustBuildRope(root)
    const orig = root.children[0] // the sole tracked node
    const a = document.createElement('p')
    a.textContent = 'a'
    const b = document.createElement('p')
    b.textContent = 'b'
    root.insertBefore(a, orig) // a, <p>aa</p>, b
    root.appendChild(b)
    // Resolving `a` (front, new): no tracked node to its left → start edge; walking
    // right passes the tracked <p>aa</p>.
    expect(nodeSpan(rope, a)).toEqual({
      startEdge: true,
      maxIx: range(rope, orig)[1],
    })
  })
})
