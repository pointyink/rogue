// @ts-check
//
// Headless editor for the agent sidecar: a jsdom-backed CRDT replica with a
// validated insert surface. Agents read the document as rope-canonical HTML and
// write whole-document (setHtml) or append (appendHtml) edits; every write is
// gated by a round-trip check so an LLM's malformed HTML is rejected instead of
// corrupting the CRDT.
//
// This is intentionally the *lean* runtime: no browser, no TinyMCE, just the
// CRDT (rogue.wasm) bound to a jsdom <div> through the same createRogueNode path
// the tests use.

import { JSDOM } from 'jsdom'
import { createRogueNode } from './sync.js'
import { buildRope, defaultSerializeNode, defaultOmitNode, defaultUnwrapNode } from './dom_rope.js'

/** Let the engine's MutationObserver deliver + process pending mutations. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/**
 * Parse `html` and re-serialize it through the rope's canonical form (the same
 * scrub + escape the CRDT render uses). Reports whether it round-trips un-mangled
 * and what it normalizes to.
 * @param {string} html @param {Document} doc
 * @returns {{ ok: boolean, cleaned: string }}
 */
export function roundTripHtml(html, doc) {
  const tmp = doc.createElement('div')
  tmp.innerHTML = html
  const rope = buildRope(tmp, defaultSerializeNode, defaultOmitNode, defaultUnwrapNode)
  const cleaned = rope ? rope.serialize() : ''
  return { ok: cleaned === html, cleaned }
}

/**
 * Create a headless editor (a CRDT replica over a jsdom <div>).
 *
 * Pass `doc`/`win`/`element` to bind an existing jsdom (e.g. the MCP server owns
 * the jsdom + sync client); otherwise a fresh jsdom is created.
 *
 * @param {{ replicaId?: number, onCommit?: (payload: Uint8Array) => void, doc?: Document, win?: Window, element?: HTMLElement }} [options]
 * @returns {Promise<HeadlessEditor>}
 */
export async function createHeadlessEditor({ replicaId, onCommit, doc, win, element } = {}) {
  if (!doc || !win || !element) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    doc = dom.window.document
    // jsdom's DOMWindow isn't the browser `Window` type sync.js expects; the
    // engine only uses the intersection (MutationObserver, getSelection, ...).
    win = /** @type {any} */ (dom.window)
    element = doc.createElement('div')
    doc.body.appendChild(element)
  }

  /** @type {Set<(payload: Uint8Array) => void>} */
  const subscribers = new Set()
  if (onCommit) subscribers.add(onCommit)

  const node = await createRogueNode({
    element,
    doc,
    win,
    replicaId,
    paste: false, // the sidecar owns insert validation; skip the engine's execCommand paste path
    onCommit: (payload) => {
      for (const cb of subscribers) cb(payload)
    },
  })

  const debug = /** @type {any} */ (win).rogue

  return makeEditorApi({ node, doc, element, debug, subscribers })
}

/**
 * The tool surface exposed to agents.
 * @param {{ node: import('./sync.js').RogueNode, doc: Document, element: HTMLElement, debug: any, subscribers: Set<(payload: Uint8Array) => void> }} ctx
 */
function makeEditorApi({ node, doc, element, debug, subscribers }) {
  return {
    /** The raw engine node (beginLoad/endLoad, setSyncDebug, ...). */
    node,

    /** The DOM element the engine is bound to. */
    element,

    /** The current document as rope-canonical HTML. */
    getHtml: () => debug.render(),

    /** Visible character length (HTML length) of the document. */
    getVisLen: () => debug.visLen(),

    /** Pre-check `html` without committing: does it round-trip un-mangled? */
    validate: (/** @type {string} */ html) => roundTripHtml(html, doc),

    /** Replace the whole document with validated HTML. */
    async setHtml(/** @type {string} */ html) {
      const { ok, cleaned } = roundTripHtml(html, doc)
      if (!ok) return { ok: false, cleaned }
      node.markUserEdit()
      element.innerHTML = cleaned
      await flush()
      return { ok: true, html: debug.render() }
    },

    /** Append a validated HTML fragment to the end of the document. */
    async appendHtml(/** @type {string} */ html) {
      const { ok, cleaned } = roundTripHtml(html, doc)
      if (!ok) return { ok: false, cleaned }
      node.markUserEdit()
      const tmp = doc.createElement('div')
      tmp.innerHTML = cleaned
      while (tmp.firstChild) element.appendChild(/** @type {Node} */ (tmp.firstChild))
      await flush()
      return { ok: true, html: debug.render() }
    },

    undo: () => node.undo(),

    redo: () => node.redo(),

    /** Apply an op from another replica (the sync entry point). */
    mergeOp: (/** @type {Uint8Array} */ payload) => node.mergeOp(payload),

    markUserEdit: () => node.markUserEdit(),

    /** Register a commit callback (payload → another replica's mergeOp). */
    subscribe(/** @type {(payload: Uint8Array) => void} */ cb) {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },

    /** Three-way consistency: CRDT render ≡ fresh DOM rope serialization. */
    assertConsistent() {
      const crdt = debug.render()
      const fresh = buildRope(element, defaultSerializeNode, defaultOmitNode, defaultUnwrapNode)
      const dom = fresh ? fresh.serialize() : ''
      return { ok: crdt === dom, crdt, dom }
    },

    destroy: () => node.destroy(),
  }
}

/**
 * @typedef {object} HeadlessEditor
 * @property {import('./sync.js').RogueNode} node
 * @property {HTMLElement} element
 * @property {() => string} getHtml
 * @property {() => number} getVisLen
 * @property {(html: string) => { ok: boolean, cleaned: string }} validate
 * @property {(html: string) => Promise<{ ok: boolean, cleaned?: string, html?: string }>} setHtml
 * @property {(html: string) => Promise<{ ok: boolean, cleaned?: string, html?: string }>} appendHtml
 * @property {() => void} undo
 * @property {() => void} redo
 * @property {(payload: Uint8Array) => void} mergeOp
 * @property {() => void} markUserEdit
 * @property {(cb: (payload: Uint8Array) => void) => () => boolean} subscribe
 * @property {() => { ok: boolean, crdt: string, dom: string }} assertConsistent
 * @property {() => void} destroy
 */
