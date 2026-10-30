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
import * as parse5 from 'parse5'
import { createRogueNode } from './sync.js'

/** HTML elements whose innerHTML content is raw text (not markup). */
const RAW_TEXT = new Set(['script', 'style', 'noscript'])
import { buildRope, defaultSerializeNode, defaultOmitNode, defaultUnwrapNode, defaultOpaqueNode } from './dom_rope.js'

/** Let the engine's MutationObserver deliver + process pending mutations. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/**
 * Parse `html` and re-serialize it through the rope's canonical form (the same
 * scrub + escape the CRDT render uses). Reports whether it round-trips un-mangled
 * and what it normalizes to.
 * @param {string} html @param {Document} doc
 * @param {import('./dom_rope.js').OpaqueNode} [opaqueNode] An opaque element's
 *   children are dropped before they reach the CRDT, so they must be dropped
 *   from the round-trip too — otherwise a widget's local markup (a table that
 *   normalizes to <tbody>, say) rejects a write that would have stored cleanly.
 * @returns {{ ok: boolean, cleaned: string }}
 */
export function roundTripHtml(html, doc, opaqueNode = defaultOpaqueNode) {
  const tmp = doc.createElement('div')
  tmp.innerHTML = html
  const rope = buildRope(tmp, defaultSerializeNode, defaultOmitNode, defaultUnwrapNode, opaqueNode)
  const cleaned = rope ? rope.serialize() : ''
  return { ok: cleaned === html, cleaned }
}

/**
 * DOM-free HTML round-trip check via parse5 — the parser jsdom is built on.
 * Same fixed-point semantics as `validHtml` (parse the fragment in `context`'s
 * tag, serialize, compare) but ~7× faster because it skips DOM construction.
 * The headless replica uses this for HTML validation (the single load check and
 * steady-state scoped checks); the browser keeps the native `validHtml`.
 * @param {string} html
 * @param {Element} [context]
 * @returns {boolean}
 */
export function parse5ValidHtml(html, context) {
  if (html === '') return true // empty round-trips in every context
  // Fragment parsing depends on the context element's local name, namespace, and
  // attributes (e.g. <annotation-xml encoding="text/html"> is an HTML integration
  // point). localName preserves foreign (SVG/MathML) camelCase.
  const name = context ? context.localName || context.tagName.toLowerCase() : 'div'
  const ns = context?.namespaceURI ?? 'http://www.w3.org/1999/xhtml'
  /** @type {any} */
  const ctx = {
    nodeName: name,
    tagName: name,
    localName: name,
    attrs: context
      ? Array.from(/** @type {any} */ (context.attributes), (a) => ({
          name: a.name,
          value: a.value,
        }))
      : [],
    namespaceURI: ns,
    childNodes: [],
    parentNode: null,
  }
  // parse5's overloads confuse tsc with a synthetic context node; call it untyped.
  const parseFragment = /** @type {any} */ (parse5.parseFragment)
  const frag = parseFragment(ctx, html)
  // Raw-text contexts: innerHTML returns the text literally, but serializing the
  // fragment escapes it. Compare the parsed text node to the input instead.
  if (ns === 'http://www.w3.org/1999/xhtml' && RAW_TEXT.has(name)) {
    const nodes = frag.childNodes
    return nodes.length === 1 && nodes[0].nodeName === '#text' && nodes[0].value === html
  }
  return parse5.serialize(frag) === html
}

/**
 * Create a headless editor (a CRDT replica over a jsdom <div>).
 *
 * Pass `doc`/`win`/`element` to bind an existing jsdom (e.g. the MCP server owns
 * the jsdom + sync client); otherwise a fresh jsdom is created.
 *
 * @param {{ replicaId?: number, onCommit?: (payload: Uint8Array) => void, doc?: Document, win?: Window, element?: HTMLElement, opaqueNode?: import('./dom_rope.js').OpaqueNode }} [options]
 * @returns {Promise<HeadlessEditor>}
 */
export async function createHeadlessEditor({ replicaId, onCommit, doc, win, element, opaqueNode } = {}) {
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
    validateHtml: parse5ValidHtml,
    opaqueNode,
    paste: false, // the sidecar owns insert validation; skip the engine's execCommand paste path
    onCommit: (payload) => {
      for (const cb of subscribers) cb(payload)
    },
  })

  const debug = /** @type {any} */ (win).rogue

  return makeEditorApi({ node, doc, element, debug, subscribers, opaqueNode })
}

/**
 * The tool surface exposed to agents.
 * @param {{ node: import('./sync.js').RogueNode, doc: Document, element: HTMLElement, debug: any, subscribers: Set<(payload: Uint8Array) => void>, opaqueNode?: import('./dom_rope.js').OpaqueNode }} ctx
 */
function makeEditorApi({ node, doc, element, debug, subscribers, opaqueNode = defaultOpaqueNode }) {
  return {
    /** The raw engine node (beginLoad/endLoad, setSyncDebug, ...). */
    node,

    /** The DOM element the engine is bound to. */
    element,

    /** The current document as rope-canonical HTML. Kept as `getHtml` because
     *  this editor is HTML by construction; `node.getString()` is the
     *  markup-agnostic equivalent. */
    getHtml: () => node.getString(),

    /** Visible character length (HTML length) of the document. */
    getVisLen: () => debug.visLen(),

    /** Pre-check `html` without committing: does it round-trip un-mangled? */
    validate: (/** @type {string} */ html) => roundTripHtml(html, doc, opaqueNode),

    /** Replace the whole document with validated HTML. */
    async setHtml(/** @type {string} */ html) {
      const { ok, cleaned } = roundTripHtml(html, doc, opaqueNode)
      if (!ok) return { ok: false, cleaned }
      node.markUserEdit()
      element.innerHTML = cleaned
      await flush()
      return { ok: true, html: debug.render() }
    },

    /** Append a validated HTML fragment to the end of the document. */
    async appendHtml(/** @type {string} */ html) {
      const { ok, cleaned } = roundTripHtml(html, doc, opaqueNode)
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
      const fresh = buildRope(element, defaultSerializeNode, defaultOmitNode, defaultUnwrapNode, opaqueNode)
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
