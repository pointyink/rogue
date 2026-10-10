// @ts-check
//
// Suggested edits (track changes) on top of a Rogue CRDT doc. A suggestion is
// anchored to a span of CRDT node ids and carries a `replacement`. Unlike
// comments, accepting one mutates the doc — but the engine knows nothing about
// suggestions: accept resolves the anchor to a DOM range and does a plain DOM
// edit (`deleteContents` + insert), and the sync engine's observer picks it up
// like any user edit. The server only records the open → accepted lifecycle.
//
// Anchoring, REST, and the `*_changed` refetch ping mirror comments.js — the
// CRDT ids are opaque here, resolved through the read-only `crdt` + `rope`
// annotation surface.

import { anchorForRange, endOfDocPos } from './comments.js'

/**
 * @typedef {{ id: string, author_id: string, start_id: string, end_id: string,
 *   replacement: string, status: string, created_at: string, updated_at: string }} Suggestion
 * @typedef {Suggestion & { range: import('./comments.js').DomRange | null }} ResolvedSuggestion
 */

/**
 * Resolve a suggestion's node-id anchor to a live DOM range with fencepost
 * semantics. Unlike comments, a suggestion brackets a *region*: if a boundary
 * char is edited away, the range steps inward to the nearest surviving visible
 * node (next_vis for the left edge, prev_vis for the right) rather than going
 * stale. Null only when the region between the ids has fully collapsed.
 *
 * @param {import('./comments.js').CrdtSurface} crdt
 * @param {import('./comments.js').RopeSurface} rope
 * @param {string} startId @param {string} endId
 * @returns {import('./comments.js').DomRange | null}
 */
export function resolveSuggestionAnchor(crdt, rope, startId, endId) {
  let s = crdt.visIxOf(startId)
  if (s === null) {
    const n = crdt.nextVisId(startId)
    s = n === null ? null : crdt.visIxOf(n)
  }
  let e = crdt.visIxOf(endId)
  if (e === null) {
    const p = crdt.prevVisId(endId)
    e = p === null ? null : crdt.visIxOf(p)
  }
  if (s === null || e === null || s > e) return null
  const start = rope.visIxToDomPos(s)
  if (!start) return null
  const end = rope.visIxToDomPos(e + 1) ?? endOfDocPos(rope, crdt.visLen())
  if (!end) return null
  return {
    startNode: start.node,
    startOffset: start.offset,
    endNode: end.node,
    endOffset: end.offset,
  }
}

/**
 * @typedef {{
 *   crdt: import('./comments.js').CrdtSurface,
 *   rope: import('./comments.js').RopeSurface,
 *   baseUrl: string,
 *   fetchFn?: import('./comments.js').CommentsFetcher,
 *   rerender?: (suggestions: ResolvedSuggestion[]) => void,
 *   onError?: (error: Error) => void,
 *   markUserEdit?: () => void,
 *   getSelectionRange?: () => import('./comments.js').DomRange | null,
 * }} SuggestionsOptions
 */

/**
 * @typedef {{
 *   load: () => Promise<ResolvedSuggestion[]>,
 *   suggestions: () => ResolvedSuggestion[],
 *   create: (replacement: string) => Promise<void>,
 *   accept: (suggestionId: string) => Promise<void>,
 *   reject: (suggestionId: string) => Promise<void>,
 *   handleDocumentChange: (range: { minIx: number, maxIx: number } | null) => void,
 *   handleRemoteChange: () => Promise<ResolvedSuggestion[]>,
 *   destroy: () => void,
 * }} Suggestions
 */

/**
 * @param {SuggestionsOptions} options
 * @returns {Suggestions}
 */
export function createSuggestions({ crdt, rope, baseUrl, fetchFn, rerender, onError, markUserEdit, getSelectionRange }) {
  /** @type {import('./comments.js').CommentsFetcher} */
  const fetchImpl = fetchFn ?? ((input, init) => globalThis.fetch(input, init))

  /** @type {Suggestion[]} */
  let suggestions = []
  let destroyed = false

  /** @param {string} path @param {RequestInit} [init]
   *  @returns {Promise<any>} */
  async function request(path, init) {
    const res = await fetchImpl(baseUrl + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
    if (!res.ok) throw new Error(`suggestions request failed: ${res.status} ${path}`)
    if (res.status === 204) return null
    return res.json()
  }

  /** @param {Suggestion} sg @returns {ResolvedSuggestion} */
  function resolve(sg) {
    return { ...sg, range: resolveSuggestionAnchor(crdt, rope, sg.start_id, sg.end_id) }
  }

  /** @returns {ResolvedSuggestion[]} */
  function resolved() {
    return suggestions.map(resolve)
  }

  function emit() {
    if (destroyed) return
    rerender?.(resolved())
  }

  /** @returns {Promise<ResolvedSuggestion[]>} */
  async function load() {
    suggestions = (await request('')) ?? []
    const out = resolved()
    emit()
    return out
  }

  /** @param {() => Promise<any>} fn */
  async function mutate(fn) {
    try {
      await fn()
      await load()
    } catch (err) {
      onError?.(/** @type {Error} */ (err))
      throw err
    }
  }

  return {
    load,

    suggestions: () => resolved(),

    create: (replacement) => {
      const range = getSelectionRange?.()
      if (!range) return Promise.reject(new Error('no text selected'))
      const anchor = anchorForRange(crdt, rope, range)
      if (!anchor) return Promise.reject(new Error('empty selection cannot be anchored'))
      return mutate(() =>
        request('', {
          method: 'POST',
          body: JSON.stringify({ ...anchor, replacement }),
        }),
      )
    },

    accept: async (suggestionId) => {
      const sg = suggestions.find((s) => s.id === suggestionId)
      if (!sg) throw new Error('suggestion not found')
      const range = resolveSuggestionAnchor(crdt, rope, sg.start_id, sg.end_id)
      if (!range) {
        const err = new Error('suggestion span is stale — review the current text before accepting')
        onError?.(err)
        throw err
      }
      // Apply as a plain DOM edit. Mark it a genuine edit first so the sync
      // engine resets its undo frontier; then the observer diff-commits it like
      // any user edit, keeping the CRDT ignorant of suggestion semantics.
      markUserEdit?.()
      const doc = range.startNode.ownerDocument
      if (!doc) {
        const err = new Error('suggestion span has no owning document')
        onError?.(err)
        throw err
      }
      const r = doc.createRange()
      r.setStart(range.startNode, range.startOffset)
      r.setEnd(range.endNode, range.endOffset)
      r.deleteContents()
      if (sg.replacement.length > 0) r.insertNode(doc.createTextNode(sg.replacement))
      await mutate(() => request(`/${suggestionId}/accept`, { method: 'POST' }))
    },

    reject: (suggestionId) =>
      mutate(() => request(`/${suggestionId}`, { method: 'DELETE' })),

    handleDocumentChange: (_range) => {
      emit()
    },

    handleRemoteChange: () => load(),

    destroy: () => {
      destroyed = true
    },
  }
}
