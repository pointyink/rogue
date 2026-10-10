// @ts-check
import { createEditorSession } from '@pointyink/rogue'
import { serializeNode, omitNode, unwrapNode } from './scrub.js'

/**
 * Options for {@link attachRogue}. If `wsUrl`, `docId`, and `getToken` are all
 * provided, attachRogue also stands up a sync client (WS + oplog + ack +
 * replay) — the customer-facing path, so plugin users don't have to wire
 * transport themselves. Consumers can still pass their own `onCommit` to intercept
 * (e.g. for offline-only dogfooding); the sync client's send and the user
 * `onCommit` both fire.
 *
 * @typedef {object} AttachOptions
 * @property {(payload: Uint8Array) => void} [onCommit]
 * @property {(bytes: number, limit: number) => void} [onOpTooLarge] Passed through
 *   to the engine — fires when an edit is rejected for exceeding maxOpBytes.
 * @property {() => void} [onDocTooLarge] Passed through to the engine — fires when
 *   an edit can't be applied because the document is at storage capacity.
 * @property {(error: { type: number, name: string, desc?: string }) => void} [onError]
 *   Passed through to the engine — fires when an operation fails for a reason
 *   other than the known limits. Receives the structured WASM error
 *   (`{ type, name, desc? }`, see CrdtErrorKind) so a host can log or toast it.
 * @property {(docId: string) => void} [onDocDeleted] Fired when the doc was
 *   deleted (this client or another); the host should navigate away/clean up.
 * @property {string} [wsUrl]
 * @property {string} [docId]
 * @property {() => Promise<string>} [getToken]
 * @property {boolean} [isNewDoc] True when this call is creating the doc — lets
 *   offline creation claim replica 1 instead of a server round-trip.
 * @property {boolean} [readOnly] True for a viewer — the editor renders and
 *   syncs but never writes (no replica allocation, no sends).
 * @property {(status: 'connecting' | 'connected' | 'disconnected') => void} [onStatus]
 * @property {(progress: number) => void} [onProgress] Fired during the initial
 *   sync (cache replay + WS stream) — progress 0..1 of the doc's bytes applied,
 *   throttled to ~100ms. Pass it through to show a determinate load bar for
 *   large docs.
 * @property {() => void} [onReady] Fired once the doc is loaded and rendered
 *   (interactive). Use it to dismiss a loading overlay.
 * @property {{ render?: (threads: import('@pointyink/rogue').ResolvedThread[]) => void,
 *   onClick?: (commentId: string) => void }} [comments]
 *   Enables comment annotations. `render` receives the resolved threads (comment
 *   + live DOM range) on every change, so the host can render a panel. `onClick`
 *   fires when the cursor lands on a commented range, so the host can pop its
 *   comment dock open to that thread. The endpoint and JWT are handled
 *   internally (derived from `wsUrl` + `docId` + `getToken`). Highlights are
 *   painted in the editor via the CSS Custom Highlight API.
 * @property {{ render?: (suggestions: import('@pointyink/rogue').ResolvedSuggestion[]) => void,
 *   onClick?: (suggestionId: string) => void }} [suggestions]
 *   Enables suggested edits. Same shape as `comments` — `render` receives the
 *   resolved suggestions, `onClick` fires when the cursor lands on a suggested
 *   span (host pops a diff + accept/reject UI). `suggestions.accept(id)` applies
 *   the replacement; `suggestions.create(replacement)` anchors the current
 *   selection; `suggestions.reject(id)` dismisses.
 */

/**
 * Attach a Rogue collab engine to a HugeRTE editor instance. This is a thin
 * adapter: it adapts HugeRTE's surface (getBody/getDoc/getWin, mode, selection,
 * events) for the shared `createEditorSession` in @pointyink/rogue, then wires
 * the HugeRTE-specific undo/IME/normalization hooks. All the collab plumbing
 * (CRDT node, sync client, doc bus, comments) lives in the shared session.
 *
 * @param {any} editor HugeRTE editor (from `hugerte.init({ setup(editor) { ... } })`)
 * @param {AttachOptions} [options]
 * @returns {Promise<{ node: import('@pointyink/rogue').RogueNode, comments: import('@pointyink/rogue').Comments | null, suggestions: import('@pointyink/rogue').Suggestions | null, deleteDoc: () => void }>}
 */
export async function attachRogue(editor, options = {}) {
  // Register the custom toolbar button SYNCHRONOUSLY (before awaiting init).
  // HugeRTE renders the toolbar during init and looks up button names against
  // the registry at that moment — anything registered after init is invisible
  // to the toolbar string. `onAction` closes over `node` which is assigned
  // post-init below; clicks before then are tolerated as no-ops.
  /** @type {any} */
  let node = null
  editor.ui.registry.addButton('rogueundo', {
    icon: 'undo',
    tooltip: 'Undo',
    onAction: () => node?.undo(),
  })
  editor.ui.registry.addButton('rogueredo', {
    icon: 'redo',
    tooltip: 'Redo',
    onAction: () => node?.redo(),
  })

  // HugeRTE init is async — wait before touching `editor.getBody()`.
  if (!editor.initialized) {
    await new Promise((resolve) => editor.once('init', resolve))
  }

  // The editor-agnostic session (CRDT node + sync + doc bus + comments). The
  // HugeRTE-specific surface is the small adapter object below.
  const { node: engineNode, comments, suggestions, deleteDoc } = await createEditorSession({
    element: editor.getBody(),
    doc: editor.getDoc(),
    win: editor.getWin(),
    serializeNode,
    omitNode,
    unwrapNode,
    setMode: (/** @type {'design' | 'readonly'} */ mode) => editor.mode.set(mode),
    getCollapsedSelection: () => {
      const sel = editor.selection.getSel()
      return sel && sel.isCollapsed
        ? { node: sel.anchorNode, offset: sel.anchorOffset }
        : null
    },
    getSelectionRange: () => {
      const sel = editor.selection.getSel()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
      const rng = sel.getRangeAt(0)
      return {
        startNode: rng.startContainer,
        startOffset: rng.startOffset,
        endNode: rng.endContainer,
        endOffset: rng.endOffset,
      }
    },
    onClick: (/** @type {() => void} */ handler) => editor.on('click', handler),
    // HugeRTE's paste-clean pipeline runs before `input`; the engine's own
    // paste listener would double-insert.
    paste: false,
    ...options,
  })
  node = engineNode

  // Stop HugeRTE's built-in undo/redo from competing with the CRDT.
  // Three surfaces to cover:
  //   1. Keyboard shortcuts (Cmd+Z, Cmd+Shift+Z, Ctrl+Y) — remove them so
  //      the engine's keydown listener handles Cmd+Z / Cmd+Shift+Z / Ctrl+Y.
  //   2. Commands (`editor.execCommand('Undo' | 'Redo')`) — override to call
  //      the engine. Toolbar buttons and menu items dispatch via these.
  //   3. The `rogueundo`/`rogueredo` toolbar buttons call the engine directly.
  for (const sc of ['meta+z', 'ctrl+z', 'meta+shift+z', 'ctrl+y']) {
    try { editor.shortcuts.remove(sc) } catch {}
  }
  editor.addCommand('Undo', () => node.undo())
  editor.addCommand('Redo', () => node.redo())

  // Tell the engine which local commits are genuine *user* edits (so they reset
  // the undo frontier) vs. HugeRTE's own structural normalization (re-wrap,
  // trailing block).
  //
  // `BeforeAddUndo` fires before real content changes (formatting, IME commits),
  // but NOT for plain typing under `custom_undo_redo_levels: 0` — so it alone
  // misses the common case. The native `input` listener below covers typing,
  // paste, Enter and backspace, and never fires for HugeRTE's normalization
  // mutations.
  editor.on('BeforeAddUndo', () => node.markUserEdit())

  // Force HugeRTE's post-input normalization (forced_root_block re-wrap,
  // trailing block) to run synchronously, in the same task as the keystroke, so
  // it lands in the same MutationObserver batch as the user's edit — one atomic
  // CRDT op per keystroke instead of two. Capture phase (`true`) runs before
  // HugeRTE's own input handling; `isComposing` leaves IME to releaseComposition.
  editor.getDoc().addEventListener(
    'input',
    (/** @type {InputEvent} */ e) => {
      if (e.isComposing || !e.isTrusted) return
      node.markUserEdit()
      editor.nodeChanged()
    },
    true,
  )

  // HugeRTE applies formatting / structural edits (bold, headings, lists,
  // Tab indent, etc.) via direct DOM mutation, which does NOT fire the
  // `input` event our engine listens to. We bridge by dispatching a synthetic
  // `input` on every event that signals "DOM was mutated by HugeRTE":
  //   - ExecCommand              → toolbar buttons, programmatic commands
  //   - FormatApply/FormatRemove → format menu, shortcut formatters
  //   - change                   → undo-checkpoint events; catches Tab indent,
  //                                Enter-creates-list-item, paste-finalization
  // Engine's input handler is idempotent (no diff = no-op), so the extra sync
  // pass after regular typing is harmless — just a wasted DMP pass.
  const dispatchInput = () => {
    editor.getBody().dispatchEvent(new Event('input', { bubbles: true }))
  }
  editor.on('ExecCommand FormatApply FormatRemove change', dispatchInput)

  return { node, comments, suggestions, deleteDoc }
}
