// @ts-check
//
// Editor-agnostic collab session: the wiring that turns a Rogue CRDT node plus
// a transport + comments config into a live collaborative editor. Every editor
// host (TinyMCE, HugeRTE, a plain contenteditable, …) supplies the same thin
// surface — the element/doc/win trio, a mode setter, a collapsed-selection
// reader, and an onClick registration — and this module does the rest:
// replica-id resolution, the CRDT node, the WS sync client, the cross-tab doc
// bus, the comment lifecycle, and the load/editable state machine.
//
// Shared by the editor plugins so the collab plumbing lives in one place; the
// plugins stay thin adapters (scrub hooks + toolbar/undo/IME wiring).

import { createRogueNode } from './sync.js'
import { createComments } from './comments.js'
import { createSuggestions } from './suggestions.js'
import { resolveReplicaId, syncBaseUrlFromWsUrl } from './replica.js'
import { createSyncClient } from './sync-client.js'
import { createDocBus } from './doc-bus.js'

/**
 * The editor surface a host adapts for the shared session. Host-specific.
 * @typedef {{
 *   element: HTMLElement,
 *   doc: Document,
 *   win: Window,
 *   serializeNode: import('./dom_rope.js').SerializeNode,
 *   omitNode: import('./dom_rope.js').OmitNode,
 *   unwrapNode: import('./dom_rope.js').UnwrapNode,
 *   setMode: (mode: 'design' | 'readonly') => void,
 *   getCollapsedSelection: () => { node: Node, offset: number } | null,
 *   getSelectionRange: () => import('./comments.js').DomRange | null,
 *   onClick: (handler: () => void) => void,
 * }} EditorSurface
 */

/**
 * @typedef {EditorSurface & {
 *   paste?: false | object,
 *   wsUrl?: string,
 *   docId?: string,
 *   getToken?: () => Promise<string>,
 *   isNewDoc?: boolean,
 *   readOnly?: boolean,
 *   onStatus?: (status: import('./sync-client.js').SyncStatus) => void,
 *   onProgress?: (progress: number) => void,
 *   onReady?: () => void,
 *   onCommit?: (payload: Uint8Array) => void,
 *   onOpTooLarge?: (bytes: number, limit: number) => void,
 *   onDocTooLarge?: () => void,
 *   onError?: (error: import('./crdt_error.js').CrdtError) => void,
 *   onDocDeleted?: (docId: string) => void,
 *   comments?: {
 *     render?: (threads: import('./comments.js').ResolvedThread[]) => void,
 *     onClick?: (commentId: string) => void,
 *   },
 *   suggestions?: {
 *     render?: (suggestions: import('./suggestions.js').ResolvedSuggestion[]) => void,
 *     onClick?: (suggestionId: string) => void,
 *   },
 * }} EditorSessionOptions
 */

/**
 * Stand up a collaborative editing session against an editor host. Returns the
 * engine node and (if enabled) the comments/suggestions APIs.
 *
 * @param {EditorSessionOptions} options
 * @returns {Promise<{ node: import('./sync.js').RogueNode, comments: import('./comments.js').Comments | null, suggestions: import('./suggestions.js').Suggestions | null, deleteDoc: () => void }>}
 */
export async function createEditorSession({
  element,
  doc,
  win,
  serializeNode,
  omitNode,
  unwrapNode,
  setMode,
  getCollapsedSelection,
  getSelectionRange,
  onClick,
  paste = false,
  wsUrl,
  docId,
  getToken,
  isNewDoc,
  readOnly,
  onStatus,
  onProgress,
  onReady,
  onCommit,
  onOpTooLarge,
  onDocTooLarge,
  onError,
  onDocDeleted,
  comments: commentsOpt,
  suggestions: suggestionsOpt,
}) {
  // Forward-declared so the node's `onCommit` / `onChange` can dispatch into
  // instances constructed after it (the sync client, the comments API).
  /** @type {import('./sync-client.js').SyncClient | null} */
  let syncClient = null
  /** @type {import('./comments.js').Comments | null} */
  let comments = null
  /** @type {import('./suggestions.js').Suggestions | null} */
  let suggestions = null
  /** @type {import('./doc-bus.js').DocBus | null} */
  let docBus = null

  // Multi-tab: `loaded` gates on the initial sync, `editable` gates on
  // permission — a read-only viewer never becomes editable.
  let loaded = false
  let editable = !readOnly
  const updateMode = () => setMode(loaded && editable ? 'design' : 'readonly')

  // Resolve a stable replica id before constructing the engine — the CRDT bakes
  // it in at init. Sync consumers get a server-allocated id (persisted per-doc);
  // a brand-new doc uses 1; a read-only viewer gets an unused random id with no
  // server round-trip.
  let replicaId
  if (wsUrl && docId && getToken) {
    replicaId = await resolveReplicaId({ docId, wsUrl, getToken, isNewDoc, readOnly })
  }

  const node = await createRogueNode({
    element,
    doc,
    win,
    serializeNode,
    omitNode,
    unwrapNode,
    replicaId,
    // Editor hosts (TinyMCE/HugeRTE) run their own paste-clean pipeline before
    // the `input` event fires; the engine's own paste listener would double-insert.
    paste,
    onOpTooLarge,
    onDocTooLarge,
    onError,
    // Re-resolve comment anchors after every visible-text change (local edits,
    // remote ops, undo/redo) — fires after the rope is rebuilt, so anchors map
    // to fresh DOM positions.
    onChange: (range) => {
      comments?.handleDocumentChange(range)
      suggestions?.handleDocumentChange(range)
    },
    onCommit: (payload) => {
      if (editable) {
        docBus?.broadcastOp(payload)
        syncClient?.send(payload)
      }
      onCommit?.(payload)
    },
  })

  // Comment annotations (REST + CSS Custom Highlight API). The engine exposes a
  // read-only `crdt` + `rope` surface for node-id ⇄ DOM resolution; this layers
  // the REST state + anchor lifecycle on top and paints highlights on every emit.
  //
  // Comments live on the sync service at a fixed route (`/docs/<id>/comments`),
  // so the endpoint is derived from `wsUrl` + `docId`, and the per-doc token
  // from `getToken` rides as the Bearer header — the host supplies only `render`
  // (draw the threads) and optionally `onClick` (a comment was clicked in the
  // text).
  /** @type {Map<string, Range>} */
  let commentRanges = new Map()
  const commentsBaseUrl = wsUrl && docId
    ? `${syncBaseUrlFromWsUrl(wsUrl)}/docs/${docId}/comments`
    : undefined
  if (commentsOpt && commentsBaseUrl) {
    const authedFetch = async (/** @type {string} */ input, /** @type {RequestInit} */ init = {}) => {
      if (!getToken) throw new Error('[rogue] comments need a token source')
      const token = await getToken()
      return fetch(input, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      })
    }
    comments = createComments({
      crdt: node.crdt,
      rope: node.rope,
      baseUrl: commentsBaseUrl,
      fetchFn: getToken ? authedFetch : undefined,
      getSelectionRange,
      rerender: (threads) => {
        commentRanges = renderCommentHighlights(win, doc, threads)
        commentsOpt.render?.(threads)
      },
      onError: (err) => console.error('[rogue] comments:', err),
    })
  }

  // Suggested edits — same anchoring/REST/refetch shape as comments. Accepting
  // resolves the anchor to a DOM range and edits the DOM directly; the engine
  // observes it like any user edit (markUserEdit keeps the undo frontier right).
  // A distinct highlight bucket so suggestions read differently from comments.
  /** @type {Map<string, Range>} */
  let suggestionRanges = new Map()
  const suggestionsBaseUrl = wsUrl && docId
    ? `${syncBaseUrlFromWsUrl(wsUrl)}/docs/${docId}/suggestions`
    : undefined
  if (suggestionsOpt && suggestionsBaseUrl) {
    const authedFetch = async (/** @type {string} */ input, /** @type {RequestInit} */ init = {}) => {
      if (!getToken) throw new Error('[rogue] suggestions need a token source')
      const token = await getToken()
      return fetch(input, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      })
    }
    suggestions = createSuggestions({
      crdt: node.crdt,
      rope: node.rope,
      baseUrl: suggestionsBaseUrl,
      fetchFn: getToken ? authedFetch : undefined,
      markUserEdit: () => node.markUserEdit(),
      getSelectionRange,
      rerender: (list) => {
        suggestionRanges = renderSuggestionHighlights(win, doc, list)
        suggestionsOpt.render?.(list)
      },
      onError: (err) => console.error('[rogue] suggestions:', err),
    })
  }

  // Clicking on a commented range notifies the host (the "auto popup" the host's
  // onClick implements). Collapsed cursor only — a non-collapsed selection is a
  // new-comment gesture, not a view gesture.
  if (commentsOpt?.onClick) {
    onClick(() => {
      if (commentRanges.size === 0) return
      const point = getCollapsedSelection()
      if (!point) return
      for (const [id, range] of commentRanges) {
        try {
          if (range.isPointInRange(point.node, point.offset)) {
            commentsOpt.onClick?.(id)
            return
          }
        } catch {
          /* stale range — skip */
        }
      }
    })
  }

  // Clicking on a suggested span opens the suggestion's diff popup (same
  // hit-test shape as comments).
  if (suggestionsOpt?.onClick) {
    onClick(() => {
      if (suggestionRanges.size === 0) return
      const point = getCollapsedSelection()
      if (!point) return
      for (const [id, range] of suggestionRanges) {
        try {
          if (range.isPointInRange(point.node, point.offset)) {
            suggestionsOpt.onClick?.(id)
            return
          }
        } catch {
          /* stale range — skip */
        }
      }
    })
  }

  // Stand up the transport if a WS URL was provided. The sync client owns
  // reconnect, oplog, ack handling, and replay — consumers don't wire it.
  if (wsUrl && docId && getToken) {
    // Block editing until the initial sync has fully loaded: the doc renders
    // once (not once per op), and the user can't type into a half-loaded doc.
    node.beginLoad()
    setMode('readonly')
    syncClient = createSyncClient({
      wsUrl,
      docId,
      mergeOp: node.mergeOp,
      getToken,
      onStatus,
      onReady: () => {
        node.endLoad()
        loaded = true
        updateMode()
        comments?.load()
        suggestions?.load()
        onReady?.()
      },
      onSyncStart: (bytes) => node.reserve(bytes >> 3), // ~8 bytes per node
      onProgress,
      onCommentChanged: () => comments?.handleRemoteChange(),
      onSuggestionChanged: () => suggestions?.handleRemoteChange(),
      onDocDeleted,
    })

    // Relay local ops to sibling tabs over a BroadcastChannel so they converge
    // clocks immediately. Guarded on feature support so older browsers fall
    // back to WS-only convergence.
    if (typeof BroadcastChannel !== 'undefined') {
      docBus = createDocBus({
        docId,
        onOp: (payload) => node.mergeOp(payload),
      })
    }
  }

  return { node, comments, suggestions, deleteDoc: () => syncClient?.sendDelete() }
}

/**
 * Paint comment highlights via the CSS Custom Highlight API — non-mutating, so
 * the highlighted ranges never enter the CRDT or DOM serialization. Two buckets:
 * active (`rogue-comment`) and resolved (`rogue-comment-resolved`), styled by
 * `::highlight(...)` rules the host adds to the editor's content styles.
 * No-ops where the API is unsupported.
 *
 * Uses a persistent per-window Highlight per bucket, mutated in place (clear +
 * add) rather than delete/re-set — some engines don't repaint a highlight that
 * was swapped out. Returns the thread id → Range map for click hit-testing.
 *
 * @param {Window} win
 * @param {Document} doc
 * @param {import('./comments.js').ResolvedThread[]} threads
 * @returns {Map<string, Range>}
 */
function renderCommentHighlights(win, doc, threads) {
  // `any`: CSS Custom Highlight API (CSS.highlights / Highlight) isn't in the
  // standard DOM lib types yet.
  const w = /** @type {any} */ (win)
  const empty = new Map()
  if (!w.CSS?.highlights || typeof w.Highlight !== 'function') return empty

  let state = windowHighlights.get(w)
  if (!state) {
    state = { active: new w.Highlight(), resolved: new w.Highlight() }
    windowHighlights.set(w, state)
    w.CSS.highlights.set('rogue-comment', state.active)
    w.CSS.highlights.set('rogue-comment-resolved', state.resolved)
  }
  state.active.clear()
  state.resolved.clear()

  /** @type {Map<string, Range>} */
  const ranges = new Map()
  for (const t of threads) {
    if (!t.range) continue
    const r = doc.createRange()
    r.setStart(t.range.startNode, t.range.startOffset)
    r.setEnd(t.range.endNode, t.range.endOffset)
    ;(t.resolved ? state.resolved : state.active).add(r)
    ranges.set(t.id, r)
  }
  return ranges
}

/** Persistent per-window Highlight objects, so re-renders mutate (clear/add)
 *  the same registered highlights instead of delete/re-setting them. */
/** @type {WeakMap<any, { active: any, resolved: any }>} */
const windowHighlights = new WeakMap()

/**
 * Paint suggestion highlights via the CSS Custom Highlight API — a single
 * `rogue-suggestion` bucket (open suggestions only; accepted/rejected ones have
 * a stale anchor and resolve to null). Mirrors renderCommentHighlights.
 *
 * @param {Window} win
 * @param {Document} doc
 * @param {import('./suggestions.js').ResolvedSuggestion[]} suggestions
 * @returns {Map<string, Range>}
 */
function renderSuggestionHighlights(win, doc, suggestions) {
  const w = /** @type {any} */ (win)
  const empty = new Map()
  if (!w.CSS?.highlights || typeof w.Highlight !== 'function') return empty

  let state = windowSuggestionHighlights.get(w)
  if (!state) {
    state = { active: new w.Highlight() }
    windowSuggestionHighlights.set(w, state)
    w.CSS.highlights.set('rogue-suggestion', state.active)
  }
  state.active.clear()

  /** @type {Map<string, Range>} */
  const ranges = new Map()
  for (const sg of suggestions) {
    // Only open suggestions highlight in the doc — accepted/rejected are done
    // (their span may still resolve after an undo, but they shouldn't re-light).
    if (sg.status !== 'open') continue
    if (!sg.range) continue
    const r = doc.createRange()
    r.setStart(sg.range.startNode, sg.range.startOffset)
    r.setEnd(sg.range.endNode, sg.range.endOffset)
    state.active.add(r)
    ranges.set(sg.id, r)
  }
  return ranges
}

/** Persistent per-window Highlight objects for suggestions. */
/** @type {WeakMap<any, { active: any }>} */
const windowSuggestionHighlights = new WeakMap()
