// @ts-check
import { diff_match_patch } from "diff-match-patch";
import DOMPurify from "dompurify";
import wasmBase64 from "./rogue.wasm.js";
import { CrdtErrorKind, parseCrdtError } from "./crdt_error.js";
import {
  buildRope,
  getOpenTag,
  getCloseTag,
  defaultSerializeNode,
  defaultOmitNode,
  defaultUnwrapNode,
  defaultOpaqueNode,
  escapeText,
} from "./dom_rope.js";

const dmp = new diff_match_patch();

/**
 * Whether an HTML string survives a browser-parse round-trip unchanged. `context`
 * is an element whose *tag* supplies the parse context — pass the region's parent
 * so `<td>`/`<tr>`/`<li>` parse in their real context (a bare `<div>` would drop
 * table internals). Omitted → a bare `<div>`. Raw innerHTML is used (not the
 * rope+scrub serialization) because the CRDT render is already clean (scrubbed +
 * escaped). Exported for direct tests.
 * @param {string} html
 * @param {Element} [context]
 * @returns {boolean}
 */
export function validHtml(html, context) {
  const tmp = context
    ? /** @type {Element} */ (context.cloneNode(false))
    : document.createElement("div");
  tmp.innerHTML = html;
  return tmp.innerHTML === html;
}

/**
 * Lightweight perf instrumentation. No-ops unless `globalThis.__rogueProfile`
 * is truthy. Read results via `performance.getEntriesByType('measure')`.
 * @template T
 * @param {string} name
 * @param {() => T} fn
 * @returns {T}
 */
function timed(name, fn) {
  if (!(/** @type {any} */ (globalThis).__rogueProfile)) return fn();
  performance.mark(`${name}-start`);
  const result = fn();
  performance.mark(`${name}-end`);
  performance.measure(name, `${name}-start`, `${name}-end`);
  return result;
}

/**
 * The vis-index span a reference node contributes to a scoped-sync range, robust
 * to the DOM churning mid-batch (see localRegion):
 *  - tracked + attached → its stable pre-mutation rope range.
 *  - new + attached     → walk the live DOM to tracked neighbours, or an edge.
 *  - detached           → nothing (its removal is bracketed by surviving siblings;
 *    an added-then-removed node is a net no-op). Never maps min/max onto a
 *    detached node — that's the trailing-content-duplication failure.
 * A boundary that runs off the doc edge is reported as `startEdge`/`endEdge` rather
 * than index 0/len-1, which could resolve back to a just-detached node.
 * @internal
 * @param {NonNullable<ReturnType<typeof buildRope>>} rope
 * @param {Node} node
 * @returns {{ minIx?: number, maxIx?: number, startEdge?: boolean, endEdge?: boolean }}
 */
export function nodeSpan(rope, node) {
  if (!node.isConnected) return {};
  const r = rope.getRange(node);
  if (r) return { minIx: r[0], maxIx: r[1] };
  // New (untracked) but attached content: walk the live DOM to tracked neighbours.
  let l = node.previousSibling;
  let lr = /** @type {[number, number] | null} */ (null);
  while (l && !(lr = rope.getRange(l))) l = l.previousSibling;
  let rt = node.nextSibling;
  let rr = /** @type {[number, number] | null} */ (null);
  while (rt && !(rr = rope.getRange(rt))) rt = rt.nextSibling;
  return {
    ...(lr ? { minIx: lr[0] } : { startEdge: true }),
    ...(rr ? { maxIx: rr[1] } : { endEdge: true }),
  };
}

/**
 * @typedef {object} RogueNodeOptions
 * @property {HTMLElement} element  The container the engine renders into and
 *   observes. It does NOT need `contenteditable` — making it editable is the
 *   host's responsibility (and is what triggers the local-edit sync path); a
 *   read-only renderer that only calls `mergeOp` works with any element. Pass a
 *   matching `doc`/`win` when the element lives in another realm (TinyMCE's iframe).
 * @property {number} [replicaId] This replica's id in the CRDT (defaults to a
 *   random u16). Override it to keep a stable identity across reloads — per-author
 *   undo, presence, and cursor attribution key off it — or to coordinate ids
 *   server-side so concurrent replicas never collide (the u16 space is ~65k).
 * @property {(payload: Uint8Array) => void} [onCommit]
 * @property {number} [maxOpBytes = 8388608] Hard cap on a single committed op
 *   batch (one edit = one wire frame). An edit whose inserts exceed this is
 *   rejected — `onOpTooLarge` fires and the DOM is reverted to the CRDT — so a
 *   pathological paste (or programmatic insert) can't blow the server's read
 *   limit. The server (WS_MAX_MESSAGE_SIZE) remains the precise backstop; this
 *   guard is the friendly first line for any host, whether or not it uses the
 *   engine's own paste listener.
 * @property {(bytes: number, limit: number) => void} [onOpTooLarge] Called when
 *   an edit is rejected for exceeding `maxOpBytes`.
 * @property {() => void} [onDocTooLarge] Called when an edit can't be applied
 *   because the document has reached its storage capacity. The edit is reverted
 *   (the CRDT is left untouched).
 * @property {{ ops?: number, opBytes?: number, crdtBytes?: number }} [sizeWarn]
 *   Soft size thresholds. When a configured metric crosses its threshold,
 *   `onSizeWarning` fires — once per crossing, re-armed when the metric falls
 *   back below half the threshold. Nothing is enforced: the edit still applies,
 *   and the host decides what to do (banner, go read-only, offer an export).
 *   Prefer `ops`: a legitimate large paste is one big op, whereas duplication
 *   shows up as an op-count blow-up.
 * @property {(stats: NodeStats, key: 'ops' | 'opBytes' | 'crdtBytes') => void} [onSizeWarning]
 *   Called with the full stats when a `sizeWarn` threshold is first crossed.
 * @property {(error: import('./crdt_error.js').CrdtError) => void} [onError]
 *   Called when an operation fails for a reason other than the known limits
 *   above — receives the structured error the WASM wrote into its output buffer
 *   (`{ type, name, desc? }`, see CrdtErrorKind), so a host can log or toast it.
 *   `out_of_memory` on the local commit path continues to route through
 *   `onDocTooLarge`.
 * @property {(range: { minIx: number, maxIx: number } | null) => void} [onChange]
 *   Called after the document's visible text changes (local edits, remote ops,
 *   undo/redo) with the affected vis-index range, or null when it can't be
 *   localized. Internal to the rogue layer — comments.js uses it to re-resolve
 *   anchored ranges; hosts generally don't need it.
 * @property {false | { maxBytes?: number, onRejected?: (bytes: number, limit: number) => void }} [paste]
 *   Paste handling. `false` skips the engine's own paste listener — hosts like
 *   TinyMCE have their own paste-clean pipeline, so running both would double-insert.
 *   An object enables it, optionally capping size (`maxBytes`) and reporting
 *   rejections (`onRejected`). Omit for the engine to handle paste with no cap.
 * @property {Document} [doc] Host abstraction — defaults work for a standard
 *   contenteditable in the main window. The TinyMCE binding overrides doc/win to
 *   operate inside the editor's iframe.
 * @property {Window} [win]
 * @property {import('./dom_rope.js').SerializeNode} [serializeNode] Host hook to
 *   serialize a (cloned) element to clean outerHTML — defaults to native
 *   `.outerHTML`. The TinyMCE host overrides it to strip `data-mce-*` so its
 *   internal attributes never enter the CRDT.
 * @property {import('./dom_rope.js').OmitNode} [omitNode] Host predicate for DOM
 *   nodes to omit entirely — editing chrome that isn't content (e.g. TinyMCE's
 *   resize handles / bogus nodes). Applied in both the rope build and the diff's
 *   DOM serializer so the CRDT never sees them.
 * @property {import('./dom_rope.js').UnwrapNode} [unwrapNode] Host
 *   predicate for wrappers to traverse transparently — their children are kept,
 *   the wrapper's own open/close tags are dropped (e.g. TinyMCE's format-caret
 *   bookmarks, which wrap real content).
 * @property {import('./dom_rope.js').OpaqueNode} [opaqueNode] Host predicate for
 *   elements to treat as opaque: the element's tags + attributes sync, but its
 *   children never enter the CRDT (the doc stores an empty shell). For embeds,
 *   widget shells, and notebook cells whose internals are local or synced
 *   separately. Precedence: `omitNode` → `unwrapNode` → `opaqueNode`.
 *
 *   The host owns the dropped subtree: it must re-mount it after every render
 *   (the engine rewrites the DOM from the CRDT), the element should be
 *   `contenteditable="false"` so the caret can't descend into unindexed content,
 *   and undo/snapshots do not cover it. Mutating it emits no ops; mutating its
 *   attributes does.
 * @property {(html: string, context?: Element) => boolean} [validateHtml]
 *   The HTML round-trip predicate used to validate ops. Defaults to the native
 *   `validHtml` (clone the context tag + `innerHTML` round-trip). The headless
 *   replica overrides it with a DOM-free `parse5` implementation — same
 *   fixed-point semantics, ~7× faster because it skips DOM construction.
 */

/**
 * Cheap (O(1)) size and integrity numbers for a live node. `crdtBytes` is the
 * CRDT arena's real footprint; it does NOT include the DOM rope or the rendered
 * DOM, which are JS heap and have no portable per-doc measure.
 * @typedef {object} NodeStats
 * @property {number} visLen      Visible UTF-16 code units.
 * @property {number} ops         Applied op groups retained for the fold.
 * @property {number} opBytes     Bytes of those retained op payloads (JS heap).
 * @property {number} crdtBytes   Bytes the CRDT arena holds in WASM.
 * @property {number} parked      Ops parked, waiting on a missing dependency.
 * @property {number} parkedDropped  Ops dropped at the parked cap. Non-zero means
 *   the CRDT is missing history — the doc should be exported and reloaded.
 */

/**
 * @typedef {{
 *   mergeOp: (payload: Uint8Array) => void,
 *   undo: () => void,
 *   redo: () => void,
 *   beginLoad: () => void,
 *   endLoad: () => void,
 *   drainParked: () => void,
 *   setSyncDebug: (on: boolean) => void,
 *   setAuthor: (author: number) => void,
 *   markUserEdit: () => void,
 *   reserve: (nodes: number) => void,
 *   stats: () => NodeStats,
 *   getString: () => string,
 *   exportOps: () => { gid: { replica: number, seq: number }, payload: Uint8Array }[],
 *   assertConsistent: () => { ok: boolean, crdt: string, dom: string },
 *   crdt: import('./comments.js').CrdtSurface,
 *   rope: import('./dom_rope.js').DomRope,
 *   destroy: () => void,
 * }} RogueNode
 */

/**
 * @param {RogueNodeOptions} options
 * @returns {Promise<RogueNode>}
 */
export async function createRogueNode({
  element: editorRoot,
  replicaId = Math.floor(Math.random() * 65534) + 1,
  onCommit,
  maxOpBytes = 8 * 1024 * 1024,
  onOpTooLarge,
  onDocTooLarge,
  sizeWarn,
  onSizeWarning,
  onError,
  onChange,
  paste,
  doc = document,
  win = window,
  serializeNode = defaultSerializeNode,
  omitNode = defaultOmitNode,
  unwrapNode = defaultUnwrapNode,
  opaqueNode = defaultOpaqueNode,
  validateHtml = validHtml,
}) {
  const wasmBytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));

  // mem is assigned after instantiation; jsLog is called only at runtime so the
  // reference is always valid by then.
  /** @type {WebAssembly.Memory} */
  let mem;
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: {
      jsLog: (/** @type {number} */ ptr, /** @type {number} */ len) =>
        console.log(
          "[wasm]",
          new TextDecoder().decode(new Uint8Array(mem.buffer, ptr, len)),
        ),
    },
  });

  // Destructure immediately so closures below don't close over a post-await const
  // (Vite's async transform creates a TDZ on const bindings captured by closures).
  const exp = /** @type {any} */ (instance.exports);
  mem = exp.memory;
  const {
    rogue_init,
    rogue_in_ptr,
    rogue_out_ptr,
    rogue_out_len,
    rogue_render,
    rogue_render_range,
    rogue_render_at,
    rogue_render_at_range,
    rogue_addr_of_range,
    rogue_begin_batch,
    rogue_hide,
    rogue_insert,
    rogue_commit_batch,
    rogue_undo,
    rogue_redo,
    rogue_merge,
    rogue_revert_tail,
    rogue_deinit,
    rogue_op_bounds,
    rogue_vis_len,
    rogue_id_at,
    rogue_vis_ix,
    rogue_prev_vis,
    rogue_next_vis,
    rogue_head,
    rogue_ca_len,
    rogue_set_debug_logging,
    rogue_set_author,
    rogue_reserve,
    rogue_used_bytes,
  } = exp;

  // Small initial SoA capacity — the doc grows toward max_nodes (2M) on demand,
  // so a tiny doc doesn't reserve ~100MB of WASM memory upfront.
  if (!rogue_init(replicaId, 1 << 16)) {
    throw new Error("rogue_init failed — out of memory allocating the CRDT");
  }

  const inPtr = rogue_in_ptr();
  const outPtr = rogue_out_ptr();

  // The rope always exists (empty document ⇒ empty rope, never null), so no call
  // site has to null-check it. Built from the editor's current content up front.
  let rope = buildRope(editorRoot, serializeNode, omitNode, unwrapNode, opaqueNode);

  /** Full rebuild: re-derive the whole rope from editorRoot's live children. */
  function rebuildRope() {
    rope.update(null, null, editorRoot);
  }

  // Divergence detector (see assertConsistent). Off unless the page URL carries
  // ?debug=sync; toggle at runtime via the returned node's setSyncDebug(). Reads
  // the ambient location defensively so it's a no-op under jsdom/tests.
  let debugSync = false;
  try {
    debugSync = /(?:^|[?&])debug=sync(?:&|$)/.test(
      globalThis.location?.search ?? "",
    );
  } catch {
    /* no ambient location — stays off */
  }
  // Mirror the flag into the WASM module so its own logs (undo cursor, getOp,
  // ...) are gated by the same ?debug=sync switch.
  rogue_set_debug_logging(debugSync ? 1 : 0);
  // Debug/bisect knob (read at runtime): when true, both the local diff and the
  // op render take their whole-document paths, bypassing all scoped machinery.
  // Lets a test isolate whether a divergence is in the surgical update or the CRDT.
  const forceFullSync = () =>
    !!(/** @type {any} */ (globalThis).__rogueForceFullSync);
  // Signature of the last-reported divergence, so a sticky mismatch isn't
  // re-shouted every settle (see assertConsistent).
  let lastDivergenceKey = "";

  /** Write a UTF-8 string into in_buf. Used for NodeId queries (`"r:s"`) and
   *  the bounds output format — wire op payloads now go through `writeBytes`.
   *  @param {string} str @returns {number} bytes written */
  function writeUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    new Uint8Array(mem.buffer, inPtr, bytes.length).set(bytes);
    return bytes.length;
  }

  /** Write a binary payload (multi_op_v0) into in_buf.
   *  @param {Uint8Array} bytes @returns {number} bytes written */
  function writeBytes(bytes) {
    new Uint8Array(mem.buffer, inPtr, bytes.byteLength).set(bytes);
    return bytes.byteLength;
  }

  /** Read a binary payload (multi_op_v0) from out_buf as a copy. We can't
   *  hand back a Uint8Array view of WASM memory because a subsequent WASM
   *  call can resize/move the linear memory; copy keeps callers safe. */
  function readBytes() {
    const len = rogue_out_len();
    const out = new Uint8Array(len);
    out.set(new Uint8Array(mem.buffer, outPtr, len));
    return out;
  }

  /** Write a UTF-16LE string into in_buf at a byte offset. @param {number} byteOffset @param {string} str @returns {number} bytes written */
  function writeUtf16At(byteOffset, str) {
    const view = new Uint16Array(mem.buffer, inPtr + byteOffset, str.length);
    for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i);
    return str.length * 2;
  }

  /** Read UTF-8 bytes from out_buf (for JSON op payloads and NodeId strings). @returns {string} */
  function readUtf8() {
    return new TextDecoder().decode(
      new Uint8Array(mem.buffer, outPtr, rogue_out_len()),
    );
  }

  /** Read the content-address JSON that rogue_undo wrote back into in_buf. */
  function readCa() {
    return new TextDecoder().decode(
      new Uint8Array(mem.buffer, inPtr, rogue_ca_len()),
    );
  }

  /** Read UTF-16LE bytes from out_buf (for HTML render output). @returns {string} */
  function readUtf16() {
    return new TextDecoder("utf-16le").decode(
      new Uint8Array(mem.buffer, outPtr, rogue_out_len()),
    );
  }

  /** Read + parse the structured error the WASM wrote into out_buf after a
   *  failed call. @returns {import('./crdt_error.js').CrdtError | null} */
  function readCrdtError() {
    return parseCrdtError(readUtf8());
  }

  // ═══════════════════════════════════════════════════════════
  // crdt — the CRDT model: vis indices, node ids, render, merge.
  // ═══════════════════════════════════════════════════════════
  let crdt = {
    /** Render the doc, or the inclusive range between two node ids. Returns
     *  null if a scoped render hits a stale fencepost id (caller should fall
     *  back to a full-doc diff) — an empty string on a real render failure.
     *  @param {string} [startId] @param {string} [endId]
     *  @returns {string | null} */
    render(startId, endId) {
      const ok =
        startId === undefined
          ? rogue_render()
          : rogue_render_range(writeUtf8(`${startId}\n${endId}`));
      if (!ok) {
        const err = readCrdtError();
        if (err?.type === CrdtErrorKind.unknown_id) {
          // A scoped-render fencepost no longer exists (the region moved under
          // an edit). Recoverable — signal the caller to fall back rather than
          // surfacing a spurious error.
          return null;
        }
        // Genuine render failure (out_buf overflow / OOM). The WASM wrote a
        // structured error; surface it and return "" rather than stale bytes.
        console.error("[sync] render failed", err);
        onError?.(err ?? { type: -1, name: "unknown" });
        return "";
      }
      return readUtf16();
    },

    /** Render the doc (or a range) at a historical content address. `addr` is the
     *  JSON [replica_id, seq] array as produced by addrOf()/head(). Returns null on
     *  a stale fencepost / bad range (caller should fall back), "" on a real failure.
     *  @param {string} addr @param {string} [startId] @param {string} [endId]
     *  @returns {string | null} */
    renderAt(addr, startId, endId) {
      const ok =
        startId === undefined
          ? rogue_render_at(writeUtf8(addr))
          : rogue_render_at_range(writeUtf8(`${addr}\n${startId}\n${endId}`));
      if (!ok) {
        const err = readCrdtError();
        if (err?.type === CrdtErrorKind.unknown_id || err?.type === CrdtErrorKind.out_of_bounds) {
          return null;
        }
        console.error("[sync] renderAt failed", err);
        onError?.(err ?? { type: -1, name: "unknown" });
        return "";
      }
      return readUtf16();
    },

    /** The content address (JSON [replica_id, seq] array) of the doc or a range.
     *  Returns null on a stale fencepost / bad range.
     *  @param {string} [startId] @param {string} [endId]
     *  @returns {string | null} */
    addrOf(startId, endId) {
      if (startId === undefined) {
        rogue_head();
        return readUtf8();
      }
      if (!rogue_addr_of_range(writeUtf8(`${startId}\n${endId}`))) {
        const err = readCrdtError();
        if (err?.type === CrdtErrorKind.unknown_id || err?.type === CrdtErrorKind.out_of_bounds) {
          return null;
        }
        console.error("[sync] addrOf failed", err);
        onError?.(err ?? { type: -1, name: "unknown" });
        return null;
      }
      return readUtf8();
    },

    /** The two visible neighbors bracketing a payload's content — valid before
     *  applying (predicted landing spot) and after (the op's own chars, via
     *  prev_vis/next_vis). @param {Uint8Array} payload */
    visIxBounds(payload) {
      if (rogue_op_bounds(writeBytes(payload)) === 0) return null;
      const parts = readUtf8().split(",");
      return { minIx: parseInt(parts[0], 10), maxIx: parseInt(parts[1], 10) };
    },

    /** The node id at a vis index, as "r:s". @param {number} ix */
    idAtVisIx(ix) {
      if (!rogue_id_at(ix)) return null;
      return readUtf8();
    },

    /** The vis index of a node id, or null if not visible. @param {string} id */
    visIxOf(id) {
      const n = rogue_vis_ix(writeUtf8(id));
      return n < 0 ? null : n;
    },

    /** The visible node id after `id`, or null past the end. @param {string} id */
    nextVisId(id) {
      return rogue_next_vis(writeUtf8(id)) ? readUtf8() : null;
    },

    /** The visible node id before `id`, or null past the start. @param {string} id */
    prevVisId(id) {
      return rogue_prev_vis(writeUtf8(id)) ? readUtf8() : null;
    },

    visLen() {
      return rogue_vis_len();
    },

    /** @param {Uint8Array} payload
     *  @returns {number} 1 = applied, 0 = parkable, -1 = permanently malformed */
    merge(payload) {
      return rogue_merge(writeBytes(payload));
    },

    /** @param {number} k @returns {number} groups actually reverted */
    revertTail(k) {
      return rogue_revert_tail(k);
    },

    /** Step inward from a captured region's outside brackets to the ids of the
     *  region's *current* content (post-mutation). Null when the region is empty
     *  or runs off a doc edge. @param {{ startCrdtId: (string|null), endCrdtId: (string|null) }} region */
    contentRange(region) {
      const startId = region.startCrdtId
        ? crdt.nextVisId(region.startCrdtId)
        : crdt.idAtVisIx(0);
      const endId = region.endCrdtId
        ? crdt.prevVisId(region.endCrdtId)
        : crdt.idAtVisIx(crdt.visLen() - 1);
      if (!startId || !endId) return null;
      const sp = crdt.visIxOf(startId);
      const ep = crdt.visIxOf(endId);
      if (sp === null || ep === null || sp > ep) return null;
      return { startId, endId };
    },
  };

  // ═══════════════════════════════════════════════════════════
  // dom — DOM tree walking, mutation, and region resolution.
  // ═══════════════════════════════════════════════════════════
  let dom = {
    /** Normalize two nodes to the tightest sibling range containing both: lift each
     *  only as far as the child of their lowest common ancestor. Null if they don't
     *  share a parent within editorRoot. @param {Node} a @param {Node} b
     *  @returns {{ start: Node, end: Node, parent: Element } | null} */
    commonParent(a, b) {
      /** @type {Map<Node, Node>} */
      const startChildOf = new Map();
      for (let n = a; n !== editorRoot && n.parentNode; n = n.parentNode) {
        startChildOf.set(n.parentNode, n);
      }
      for (let n = b; n.parentNode; n = n.parentNode) {
        const parent = n.parentNode;
        const s = startChildOf.get(parent);
        if (s) return { start: s, end: n, parent: /** @type {Element} */ (parent) };
        if (parent === editorRoot) break;
      }
      return null;
    },

    /** The nearest previous/next sibling the rope tracks, null at the parent's edge.
     *  @param {Node} node @returns {Node | null} */
    trackedPrevSibling(node) {
      let n = node.previousSibling;
      while (n && !rope.getRange(n)) n = n.previousSibling;
      return n;
    },
    /** @param {Node} node @returns {Node | null} */
    trackedNextSibling(node) {
      let n = node.nextSibling;
      while (n && !rope.getRange(n)) n = n.nextSibling;
      return n;
    },

    /** The dom nodes (tight sibling range + parent) bracketing a vis range.
     *  @param {number} startIx @param {number} endIx
     *  @returns {{ start: Node, end: Node, parent: Element } | null} */
    nodesForVisRange(startIx, endIx) {
      if (rope.length === 0) return null;
      const last = rope.length - 1;
      const startHit = rope.getAtVisIx(Math.max(0, Math.min(startIx, last)));
      const endHit = rope.getAtVisIx(Math.max(0, Math.min(endIx, last)));
      if (!startHit || !endHit) {
        if (debugSync)
          console.error("nodesForVisRange: null hit on clamped index", {
            startIx,
            endIx,
            last,
          });
        return null;
      }
      return dom.commonParent(startHit.node.domNode, endHit.node.domNode);
    },

    /** The fenceposts around a region: tracked neighbours just outside it.
     *  @param {Node} regionStart @param {Node} regionEnd @param {Element} parent
     *  @returns {SyncRegion} */
    fenceposts(regionStart, regionEnd, parent) {
      return {
        before: dom.trackedPrevSibling(regionStart),
        after: dom.trackedNextSibling(regionEnd),
        parent,
      };
    },

    /** OpSync: fenceposts + stable outside-bracket ids (op / undo path).
     *  @param {Node} regionStart @param {Node} regionEnd @param {Element} parent
     *  @returns {OpSync | null} */
    captureRegion(regionStart, regionEnd, parent) {
      const s = rope.getRange(regionStart);
      const e = regionStart === regionEnd ? s : rope.getRange(regionEnd);
      if (!s || !e) return null;
      return {
        ...dom.fenceposts(regionStart, regionEnd, parent),
        startCrdtId: s[0] > 0 ? crdt.idAtVisIx(s[0] - 1) : null,
        endCrdtId: e[1] < crdt.visLen() - 1 ? crdt.idAtVisIx(e[1] + 1) : null,
      };
    },

    /** LocalSync: fenceposts + the region's own vis span (observer path).
     *  @param {Node} regionStart @param {Node} regionEnd @param {Element} parent
     *  @returns {LocalSync | null} */
    captureLocalRegion(regionStart, regionEnd, parent) {
      const s = rope.getRange(regionStart);
      const e = regionStart === regionEnd ? s : rope.getRange(regionEnd);
      if (!s || !e) return null;
      return {
        ...dom.fenceposts(regionStart, regionEnd, parent),
        startVisIx: s[0],
        endVisIx: e[1],
      };
    },

    /** The escalation chain for op-derived bounds: tight region → … → editorRoot child.
     *  @param {{ minIx: number, maxIx: number } | null} bounds
     *  @returns {OpSync[] | null} */
    regionForVisBounds(bounds) {
      if (!bounds) return null;
      const lastIx = crdt.visLen() - 1;
      if (bounds.minIx <= 0 && bounds.maxIx >= lastIx) return null;
      const pair = dom.nodesForVisRange(
        Math.max(0, Math.min(bounds.minIx, lastIx)),
        Math.max(0, Math.min(bounds.maxIx, lastIx)),
      );
      if (!pair) return null;
      const tight = dom.captureRegion(pair.start, pair.end, pair.parent);
      if (!tight) return null;
      const levels = [tight];
      for (
        let el = pair.parent;
        el !== editorRoot;
        el = /** @type {Element} */ (el.parentNode)
      ) {
        const level = dom.captureRegion(el, el, /** @type {Element} */ (el.parentNode));
        if (!level) return null;
        levels.push(level);
      }
      return levels;
    },

    /** Splice the rope for a region; whole-rope rebuild on an invariant violation.
     *  @param {SyncRegion} region */
    resyncRope(region) {
      try {
        rope.update(region.before, region.after, region.parent);
      } catch (err) {
        console.error("[rope] scoped resync failed — rebuilding whole rope", err);
        rebuildRope();
      }
    },

    /** Concatenated clean HTML between two fenceposts.
     *  @param {Node | null} before @param {Node | null} after @param {Element} parent
     *  @returns {string} */
    htmlBetween(before, after, parent) {
      const first = before ? before.nextSibling : parent.firstChild;
      const last = after ? after.previousSibling : parent.lastChild;
      if (!first || first === after) return "";
      return rangeOuterHtml(first, last);
    },

    /** Replace the region between two fenceposts with new HTML.
     *  @param {Node | null} before @param {Node | null} after @param {Element} parent
     *  @param {string} html */
    swap(before, after, parent, html) {
      selfMutate(() => {
        const range = doc.createRange();
        if (before) range.setStartAfter(before);
        else range.setStart(parent, 0);
        if (after) range.setEndBefore(after);
        else range.setEnd(parent, parent.childNodes.length);
        range.deleteContents();
        range.insertNode(htmlToFragment(html, parent));
      });
    },

    /** Render the first scope whose html balances, and splice it into the DOM.
     *  Walks tight → top-level block; falling through every scope (false) is the
     *  caller's signal that the merged content is invalid HTML → reject.
     *  @param {OpSync[]} scopes
     *  @returns {boolean} true if a scope was rendered */
    renderOp(scopes) {
      for (const scope of scopes) {
        const ids = crdt.contentRange(scope);
        const html = ids ? crdt.render(ids.startId, ids.endId) : "";
        if (html === null) continue; // stale scope fencepost — try the next scope
        if (validateHtml(html, scope.parent)) {
          dom.swap(scope.before, scope.after, scope.parent, html);
          dom.resyncRope(scope);
          return true;
        }
      }
      return false;
    },

    /** Full-document render, only if the DOM actually differs. */
    fullRender() {
      const newHtml = crdt.render() ?? "";
      if (newHtml !== cleanInnerHtml()) {
        timed("innerhtml_set", () =>
          selfMutate(() => {
            editorRoot.innerHTML = newHtml;
          }),
        );
        timed("rope_rebuild", () => rebuildRope());
        restoreCursor(cursorIds);
      }
    },

    /** Unconditional full render (used after remote ops where the DOM may be stale). */
    forceFullRender() {
      const newHtml = crdt.render() ?? "";
      timed("innerhtml_set", () =>
        selfMutate(() => {
          editorRoot.innerHTML = newHtml;
        }),
      );
      timed("rope_rebuild", () => rebuildRope());
      restoreCursor(cursorIds);
    },
  };

  /**
   * Concatenated clean HTML of `first` through `last` (consecutive siblings), with
   * element serialization routed through the host `serializeNode` hook so the DOM
   * side of the diff matches the rope's clean serialization. A null boundary resolves to
   * editorRoot's first/last child (the region runs to the editor's edge).
   * @param {Node | null} first
   * @param {Node | null} last
   * @returns {string}
   */
  function rangeOuterHtml(first, last) {
    first = first ?? editorRoot.firstChild;
    last = last ?? editorRoot.lastChild;
    if (!first || !last) return "";
    // Route serialization the same way the rope serializes its nodes, so the DOM
    // side of the diff is clean-vs-clean with the CRDT render. Text nodes are HTML-
    // escaped (escapeText: & < > and   → &nbsp;) exactly as the rope tokenizer
    // does — a bare `.data` would leave a trailing-space   unescaped and desync
    // the diff (both the char and the HTML-offset math). Elements go through the host
    // serializeNode hook (deep clone — the hook may mutate it, e.g. strip internal
    // attrs / drop nested bogus nodes); browser .outerHTML already escapes their text.
    /** Does `root`'s subtree contain an opaque element? O(k), and only the
     *  element tree — no serialization. */
    const containsOpaque = (/** @type {Element} */ root) => {
      for (let el = root.firstElementChild; el; el = el.nextElementSibling) {
        if (opaqueNode(el) || containsOpaque(el)) return true;
      }
      return false;
    };
    /** Hook-consistent serialization, mirroring toRopeNodes. Used only when an
     *  opaque node is in play: a deep clone would carry its local children into
     *  the diff, which then pushes them into the CRDT — the exact leak the hook
     *  exists to prevent. */
    const serializeDeep = (/** @type {Node} */ node) => {
      if (omitNode(node)) return "";
      if (node.nodeType === 3) return escapeText(/** @type {Text} */ (node).data);
      if (node.nodeType !== 1) return "";
      const el = /** @type {Element} */ (node);
      if (unwrapNode(el)) {
        let s = "";
        for (const child of el.childNodes) s += serializeDeep(child);
        return s;
      }
      const open = getOpenTag(el, serializeNode);
      if (opaqueNode(el)) return open + getCloseTag(el);
      let s = open;
      for (const child of el.childNodes) s += serializeDeep(child);
      return s + getCloseTag(el);
    };
    const serialize = (/** @type {Node} */ node) => {
      if (omitNode(node)) return "";
      if (node.nodeType === 3) return escapeText(/** @type {Text} */ (node).data);
      if (node.nodeType === 1) {
        if (unwrapNode(node)) {
          let s = "";
          for (const child of node.childNodes) s += serialize(child);
          return s;
        }
        const el = /** @type {Element} */ (node);
        // Opaque: the shell only.
        if (opaqueNode(el)) return serializeNode(/** @type {Element} */ (el.cloneNode(false)));
        // Fast path unchanged unless an opaque descendant forces the walk. Skip
        // the scan entirely when the host didn't opt in (the TinyMCE/HugeRTE
        // hot path stays byte-identical).
        if (opaqueNode !== defaultOpaqueNode && containsOpaque(el)) return serializeDeep(el);
        return serializeNode(/** @type {Element} */ (el.cloneNode(true)));
      }
      return "";
    };
    if (first === last) return serialize(first);
    let html = "";
    let cur = /** @type {Node | null} */ (first);
    while (cur) {
      html += serialize(cur);
      if (cur === last) break;
      cur = cur.nextSibling;
    }
    return html;
  }

  /**
   * Parse an HTML string into a DocumentFragment of sibling nodes, *in the parsing
   * context of `parent`*. This matters for table internals: `<td>…</td>` parsed
   * inside a `<div>` loses its tags (a `<td>` isn't valid there), but parsed inside
   * a `<tr>` clone it's preserved. An empty clone of `parent` supplies that context.
   * @param {string} html
   * @param {Element} parent
   * @returns {DocumentFragment}
   */
  function htmlToFragment(html, parent) {
    const tmp = /** @type {Element} */ (parent.cloneNode(false));
    tmp.innerHTML = html;
    const frag = doc.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    return frag;
  }

  /**
   * The fenceposts of a touched region: the surviving DOM nodes just *before* and
   * *after* it — `before`/`after`, each null → the parent's edge — plus their
   * common `parent`. They sit *outside* the region, so a swap can't detach them;
   * both the DOM swap and the rope resync operate on the region *between* them. The
   * shared part of both sync structs.
   * @typedef {{ before: Node | null, after: Node | null, parent: Element }} SyncRegion
   */

  /**
   * SyncRegion + the region's own vis span, for the local (DOM-edit) path. The CRDT
   * is pre-edit, so positions are current — render/diff the region by index.
   * `structural` marks a batch that removed a node (identical-clone replacement):
   * the rope tracks the stale identity, so it must resync even when the diff is empty.
   * @typedef {SyncRegion & { startVisIx: number, endVisIx: number, structural?: boolean }} LocalSync
   */

  /**
   * SyncRegion + stable outside-bracket ids, for the op (network/undo) path. The
   * region *shifts* when the op applies, so its own positions go stale; the bracket
   * ids — the char just outside each end, null at a doc edge — sit outside the edit
   * and survive the merge, so the render steps inward from them (next_vis/prev_vis)
   * to the region's new content, catching inserts at the region's own edge.
   * @typedef {SyncRegion & { startCrdtId: string | null, endCrdtId: string | null }} OpSync
   */

  /**
   * Union of the tail groups' vis bounds — the region the reverted tail currently
   * occupies, so the head can be restored into it. Null if any group's bounds can't
   * be resolved (→ the caller falls back to a full rerender).
   * @param {{ gid: Gid, payload: Uint8Array }[]} groups
   * @param {number} from
   * @returns {{ minIx: number, maxIx: number } | null}
   */
  function tailVisBounds(groups, from) {
    let minIx = Infinity;
    let maxIx = -Infinity;
    for (let i = from; i < groups.length; i++) {
      const b = crdt.visIxBounds(groups[i].payload);
      if (!b) return null;
      if (b.minIx < minIx) minIx = b.minIx;
      if (b.maxIx > maxIx) maxIx = b.maxIx;
    }
    return { minIx, maxIx };
  }

  /**
   * Observer (user edit): a batch of MutationRecords → the DOM region they touched →
   * a LocalSync. Reference nodes resolve to a pre-mutation vis span via nodeSpan
   * (rope-space, immune to mid-batch churn), folded into [minIx, maxIx] + edge
   * flags; the union resolves to the tight region and its fenceposts. A new
   * (untracked) outward neighbour needs no special-casing — trackedBefore/Next simply
   * skips it to the surviving fencepost, so the resync re-derives that new content.
   * Returns null (→ full-document diff) when nothing tracked anchors the change.
   * @param {MutationRecord[]} records
   * @returns {LocalSync | null}
   */
  function localRegion(records) {
    const activeRope = rope; // rope is a `let`; capture for the closures below

    let minIx = Infinity;
    let maxIx = -Infinity;
    let startEdge = false;
    let endEdge = false;
    // A removal may churn node identity without changing content (identical clone),
    // leaving the rope stale even when the diff comes out empty.
    const structural = records.some((r) => r.removedNodes.length > 0);
    /** @param {ReturnType<typeof nodeSpan>} c */
    const fold = (c) => {
      if (c.minIx !== undefined && c.minIx < minIx) minIx = c.minIx;
      if (c.maxIx !== undefined && c.maxIx > maxIx) maxIx = c.maxIx;
      if (c.startEdge) startEdge = true;
      if (c.endEdge) endEdge = true;
    };

    for (const rec of records) {
      if (rec.type === "childList") {
        const root = rec.target === editorRoot;
        if (rec.previousSibling)
          fold(nodeSpan(activeRope, rec.previousSibling));
        else if (root) startEdge = true;
        if (rec.nextSibling) fold(nodeSpan(activeRope, rec.nextSibling));
        else if (root) endEdge = true;
        // Inside a block with a missing bracket, the block itself bounds the change.
        if (!root && (!rec.previousSibling || !rec.nextSibling))
          fold(nodeSpan(activeRope, rec.target));
      } else {
        fold(nodeSpan(activeRope, rec.target)); // characterData / attributes
      }
    }

    // No tracked anchor anywhere → nothing resolvable, or a whole-doc replacement.
    if (minIx === Infinity && maxIx === -Infinity) return null;
    // A change reaching the doc edge extends the region to it (index 0 / last).
    if (startEdge || minIx === Infinity) minIx = 0;
    if (endEdge || maxIx === -Infinity) maxIx = activeRope.length - 1;

    const pair = dom.nodesForVisRange(minIx, maxIx);
    if (!pair) return null;
    const sync = dom.captureLocalRegion(pair.start, pair.end, pair.parent);
    if (!sync) return null;
    return { ...sync, structural };
  }

  /**
   * End-of-doc DOM position: after the last visible char in the rope.
   * @param {NonNullable<ReturnType<typeof buildRope>>} rope
   * @param {number} visLen
   * @returns {{ node: Node, offset: number } | null}
   */
  function endOfDocPos(rope, visLen) {
    const last = visLen > 0 ? rope.getAtVisIx(visLen - 1) : null;
    if (!last) return null;
    if (last.node.kind === "text") {
      const t = /** @type {Text} */ (last.node.domNode);
      return { node: t, offset: t.data.length };
    }
    const el = /** @type {Element} */ (last.node.domNode);
    const parent = el.parentNode;
    if (!parent) return null;
    return {
      node: parent,
      offset: Array.from(parent.childNodes).indexOf(el) + 1,
    };
  }

  /**
   * Cursor position = (nodeId, inclusive/exclusive).
   *   exclusive = before this char (default)
   *   inclusive = after this char (used at end-of-doc)
   * @returns {{ anchorId: string, focusId: string, focusInclusive?: boolean } | null}
   */
  function saveCursor() {
    const sel = win.getSelection();
    if (!sel || !sel.rangeCount) return null;
    if (!editorRoot.contains(sel.anchorNode)) return null;

    const anchorHtml = rope.domPosToVisIx(
      /** @type {Node} */ (sel.anchorNode),
      sel.anchorOffset,
    );
    const focusHtml = rope.domPosToVisIx(
      /** @type {Node} */ (sel.focusNode),
      sel.focusOffset,
    );
    if (anchorHtml === null || focusHtml === null) return null;

    const visLen = rogue_vis_len();

    // Collapsed at end of doc: both offsets past last char.
    if (anchorHtml === focusHtml && anchorHtml >= visLen) {
      if (visLen === 0) return null;
      if (!rogue_id_at(visLen - 1)) return null;
      const id = readUtf8();
      return { anchorId: id, focusId: id, focusInclusive: true };
    }

    // Resolve each endpoint. At end-of-doc, use last char inclusive.
    let anchorId,
      anchorInclusive = false;
    if (!rogue_id_at(anchorHtml)) {
      if (anchorHtml >= visLen && visLen > 0) {
        rogue_id_at(visLen - 1);
        anchorId = readUtf8();
        anchorInclusive = true;
      } else {
        return null;
      }
    } else {
      anchorId = readUtf8();
    }

    // Collapsed mid-doc.
    if (anchorHtml === focusHtml) {
      return { anchorId, focusId: anchorId };
    }

    let focusId,
      focusInclusive = false;
    if (!rogue_id_at(focusHtml)) {
      if (focusHtml >= visLen && visLen > 0) {
        rogue_id_at(visLen - 1);
        focusId = readUtf8();
        focusInclusive = true;
      } else {
        return null;
      }
    } else {
      focusId = readUtf8();
    }

    // Normalize: anchorId = left edge, focusId = right edge.
    let leftId, rightId, rightInclusive;
    if (anchorHtml <= focusHtml) {
      leftId = anchorId;
      rightId = focusId;
      rightInclusive = focusInclusive;
    } else {
      leftId = focusId;
      rightId = anchorId;
      rightInclusive = anchorInclusive;
    }
    return {
      anchorId: leftId,
      focusId: rightId,
      focusInclusive: rightInclusive,
    };
  }

  // Cursor IDs saved by user interaction only (click or direct edit).
  // Undo and incoming network ops must not update this — they just restore to it.
  /** @type {{ anchorId: string, focusId: string, focusInclusive?: boolean } | null} */
  let cursorIds = null;
  let programmaticSelection = false;
  /** @type {number | null} */
  let pendingSelectionSave = null;

  /** @param {{ anchorId: string, focusId: string, focusInclusive?: boolean } | null} saved */
  function restoreCursor(saved) {
    if (!saved) return;
    programmaticSelection = true;
    try {
      const visLen = rogue_vis_len();

      // Resolve anchor (left edge): if deleted, look left; if nothing there, use 0.
      let anchorWasDeleted = false;
      let anchorIx = rogue_vis_ix(writeUtf8(saved.anchorId));
      if (anchorIx < 0) {
        anchorWasDeleted = true;
        const found = rogue_prev_vis(writeUtf8(saved.anchorId));
        const prevId = found ? readUtf8() : null;
        anchorIx = prevId ? rogue_vis_ix(writeUtf8(prevId)) : 0;
      }

      const anchor = rope.visIxToDomPos(anchorIx);
      if (!anchor) return;

      // Collapsed selection
      if (saved.anchorId === saved.focusId) {
        if (saved.focusInclusive) {
          const pos =
            rope.visIxToDomPos(anchorIx + 1) ?? endOfDocPos(rope, visLen);
          if (!pos) return;
          win
            .getSelection()
            ?.setBaseAndExtent(pos.node, pos.offset, pos.node, pos.offset);
        } else {
          win
            .getSelection()
            ?.setBaseAndExtent(
              anchor.node,
              anchor.offset,
              anchor.node,
              anchor.offset,
            );
        }
        return;
      }

      // Resolve focus (right edge): if deleted, look right; if nothing, end of doc.
      const rawFocusIx = rogue_vis_ix(writeUtf8(saved.focusId));
      let focus = null;
      let focusWasDeleted = false;

      if (rawFocusIx >= 0) {
        if (saved.focusInclusive) {
          focus =
            rope.visIxToDomPos(rawFocusIx + 1) ?? endOfDocPos(rope, visLen);
        } else {
          focus = rope.visIxToDomPos(rawFocusIx);
        }
      } else {
        focusWasDeleted = true;
        const found = rogue_next_vis(writeUtf8(saved.focusId));
        if (found) {
          const nextIx = rogue_vis_ix(writeUtf8(readUtf8()));
          focus = rope.visIxToDomPos(nextIx);
        } else {
          focus = endOfDocPos(rope, visLen);
        }
      }

      if (!focus) return;

      if (anchorWasDeleted && focusWasDeleted) {
        win
          .getSelection()
          ?.setBaseAndExtent(
            focus.node,
            focus.offset,
            focus.node,
            focus.offset,
          );
        return;
      }

      if (rawFocusIx >= 0 && rawFocusIx <= anchorIx) {
        win
          .getSelection()
          ?.setBaseAndExtent(
            anchor.node,
            anchor.offset,
            anchor.node,
            anchor.offset,
          );
        return;
      }

      win
        .getSelection()
        ?.setBaseAndExtent(
          anchor.node,
          anchor.offset,
          focus.node,
          focus.offset,
        );
    } finally {
      programmaticSelection = false;
    }
  }

  // During initial bootstrap (beginLoad → endLoad) ops are merged into the CRDT
  // but neither rendered nor validated per op. endLoad validates the final render
  // once and walks back on failure (recoverLoad). See docs/plan-load-walkback.md.
  let loading = false;
  // True while endLoad replays the tail after a walk-back: suppresses host
  // callbacks so a load settles like one render, not N remote ops.
  let booting = false;
  // Re-entrancy guard for drainParked: it routes below-head parked ops through
  // applyOp, whose own tail calls drainParked again.
  let draining = false;

  // The affected vis-index range of the most recent change, set by applyDiff /
  // applyOp and consumed by finishSync's onChange so it fires after the rope has
  // been rebuilt (anchors resolve to correct DOM positions).
  /** @type {{ minIx: number, maxIx: number } | null} */
  let lastChangeRange = null;

  // The undo frontier: a content address (JSON array of [replica_id, seq] pairs)
  // marking how far back through the oplog undo has walked. `null` = "stale —
  // refresh from doc.head on the next undo" (set after any local edit so undo
  // starts from the latest state; remote ops leave it, so undo can walk into
  // loaded/peer history). The CRDT does the walking: rogue_undo inverts the op at
  // the given address and returns the address one step further back (undo(ca) -> ca).
  let ca = /** @type {string | null} */ (null);

  // How many undo steps are still redoable. Incremented on each successful undo,
  // decremented on each redo, and reset to 0 on a genuine user edit (a new edit
  // invalidates the redo history, exactly like it resets `ca`). Redo is a no-op at
  // 0 — this is the "halt" that the CRDT's redo deliberately doesn't enforce, since
  // it re-applies every group (including undo's inverses) and would otherwise
  // oscillate past the point the user actually undid.
  let undoDepth = 0;

  // One-shot marker that the next local commit is a genuine *user* edit (not
  // TinyMCE's own re-wrap/trailing-block normalization). Armed by the host via
  // `markUserEdit()` (wired to the host's "this is a user edit" event) and by the
  // engine on composition release; consumed by applyDiff to reset the undo frontier.
  let userEditPending = false;

  /** The document head as a content-address JSON string. */
  function rogueHead() {
    rogue_head();
    return readUtf8();
  }

  /** Invert the op at `ca`, returning its inverse payload and the decremented
   *  address (null if there's nothing left to undo). `ca` is a content-address
   *  JSON string; pass null to start from the document head.
   *  @param {string | null} ca @returns {{ payload: Uint8Array, nextCa: string } | null} */
  function rogueUndo(ca) {
    const frontier = ca ?? rogueHead();
    if (!rogue_undo(writeUtf8(frontier))) return null;
    return { payload: readBytes(), nextCa: readCa() };
  }

  /** Invert the next op past `ca`, returning its inverse payload and the advanced
   *  address (null if there's nothing past the cursor). The forward counterpart
   *  of rogueUndo: "move forward" re-inverts the next group, which re-applies it
   *  when that group was an undo's inverse. @param {string} ca */
  function rogueRedo(ca) {
    if (!rogue_redo(writeUtf8(ca))) return null;
    return { payload: readBytes(), nextCa: readCa() };
  }

  /** @param {string} crdtHtml @param {string} domHtml @param {number} offset */
  function applyDiff(crdtHtml, domHtml, offset) {
    if (crdtHtml === domHtml) return;
    const diffs = timed("dmp_diff", () => dmp.diff_main(crdtHtml, domHtml));
    // Span of the diff in the CRDT's pre-edit vis coordinates — a conservative
    // affected range for onChange (covers both the deleted and inserted text).
    let span = 0;
    for (const [op, text] of diffs) span += text.length;
    // Reject an edit whose inserts exceed the op cap before mutating the CRDT.
    // UTF-16 units × 2 is the WASM buffer size — an upper bound on the wire's
    // UTF-8 bytes for ASCII, and close enough elsewhere. The server enforces the
    // exact byte limit; this guard is the friendly first line for any host.
    if (maxOpBytes) {
      let insertBytes = 0;
      for (const [op, text] of diffs) if (op === 1) insertBytes += text.length * 2;
      if (insertBytes > maxOpBytes) {
        onOpTooLarge?.(insertBytes, maxOpBytes);
        dom.forceFullRender();
        return false;
      }
    }
    const applied = timed("wasm_batch", () => {
      rogue_begin_batch();
      let pos = offset;
      let bufOff = 0;
      let stampFailed = false;
      for (const [op, text] of diffs) {
        if (op === 0) {
          pos += text.length;
        } else if (op === -1) {
          if (!rogue_hide(pos, text.length)) { stampFailed = true; break; }
          pos += text.length;
        } else {
          const byteLen = writeUtf16At(bufOff, text);
          if (!rogue_insert(pos, bufOff, byteLen)) { stampFailed = true; break; }
          bufOff += byteLen;
        }
      }
      if (stampFailed) {
        // A hide/insert failed to stamp (vis_ix out of bounds / OOM), so the
        // batch is partial and must not commit. Discard it (the next begin_batch
        // clears op_buf) and revert the DOM to the CRDT instead of silently
        // committing a desynced subset.
        const err = readCrdtError();
        console.error("[sync] local edit stamp failed", err);
        onError?.(err ?? { type: -1, name: "unknown" });
        dom.forceFullRender();
        return false;
      }
      const committed = rogue_commit_batch();
      if (committed === -1) {
        // Merge failed — the pre-check left the CRDT untouched, so just revert
        // the DOM (discard the edit) and report instead of silently desyncing.
        const err = readCrdtError();
        console.error("[sync] local commit failed", err);
        if (err?.type === CrdtErrorKind.out_of_memory) onDocTooLarge?.();
        else onError?.(err ?? { type: -1, name: "unknown" });
        dom.forceFullRender();
        return false;
      }
      if (committed) {
        const payload = readBytes();
        trackApplied(gidOf(payload), payload);
        onCommit?.(payload);
        maybeWarnSize();
        lastChangeRange = { minIx: offset, maxIx: offset + span };
        if (userEditPending) {
          userEditPending = false;
          ca = null; // a genuine user edit resets the undo frontier to head
          undoDepth = 0; // ...and invalidates the redo history
        }
        if (debugSync) {
          // A real op committed — the CRDT actually changed. Green, and shows the
          // edits (−deleted / +inserted) so it stands apart from the DOM-churn logs
          // above it, which resolve/diff but produce nothing.
          const edits = diffs
            .filter(([op]) => op !== 0)
            .map(
              ([op, text]) => `${op === -1 ? "−" : "+"}${JSON.stringify(text)}`,
            )
            .join(" ");
          console.log(
            `%c[crdt] op committed @ ${offset}`,
            "color:#0a0;font-weight:bold",
            edits,
          );
        }
      }
      return true;
    });
    return applied;
  }

  /**
   * Update the rope + cursor after a diff has been applied to the CRDT.
   * @param {() => void} rebuild Rope-refresh strategy: a scoped `updateRope(range)`
   *   for a localized edit, or a full `rebuildRope` when the whole document changed.
   */
  function finishSync(rebuild) {
    // Skip rerender: applyDiff made CRDT chars match DOM chars, so a render
    // would just produce the same HTML innerHTML already holds. Burns ~half
    // the per-keystroke time on large docs. Network ops + undo still rerender
    // explicitly because their CRDT changes don't have a corresponding DOM edit.
    timed("rope_rebuild", rebuild);
    const ids = timed("save_cursor", () => saveCursor());
    if (ids) cursorIds = ids;
    // Fire onChange after the rope rebuild so anchors resolve to correct DOM
    // positions; then clear it for the next change.
    if (lastChangeRange) {
      onChange?.(lastChangeRange);
      lastChangeRange = null;
    }
    assertConsistent("finishSync");
  }

  /**
   * The local path's workhorse: diff the CRDT content at the scoped DOM
   * span — positions are still current pre-edit) against the DOM content between
   * the fenceposts, apply the delta, and resync the rope.
   * @param {LocalSync} range
   * @returns {boolean} whether a change was applied
   */
  function diffToCrdt(range) {
    const startId = crdt.idAtVisIx(range.startVisIx);
    const endId = crdt.idAtVisIx(range.endVisIx);
    const crdtSub = startId && endId ? crdt.render(startId, endId) : "";
    if (crdtSub === null) {
      // A region fencepost id went stale (it was removed mid-edit) — the
      // surgical diff can't be computed. Fall back to the full-doc path.
      fullDocDiff();
      return false;
    }
    const domSub = dom.htmlBetween(range.before, range.after, range.parent);
    if (crdtSub === domSub) {
      // Content matches, so no CRDT op — but a removal in this batch may have
      // churned node identity (a fresh clone in place). Refresh the rope for the
      // range so it tracks the live nodes; otherwise getRange/cursor lookups miss.
      if (range.structural) finishSync(() => dom.resyncRope(range));
      return false;
    }
    if (debugSync) {
      // The exact inputs handed to the offset-diff. The last one logged before a
      // red divergence banner is the diff that desynced — compare crdt vs dom and
      // check startVisIx against where they actually differ.
      console.log(
        `%c[diff] scoped @ startVisIx ${range.startVisIx}`,
        "color:#59f;font-weight:bold",
        "\ncrdt:",
        JSON.stringify(crdtSub),
        "\ndom :",
        JSON.stringify(domSub),
      );
    }
    if (applyDiff(crdtSub, domSub, range.startVisIx) === false) return false;
    // Only this region's DOM changed, so patch just its rope span (O(log n + k))
    // instead of rebuilding the whole document's rope.
    finishSync(() => dom.resyncRope(range));
    return true;
  }

  /**
   * Full-document fallback: diff the entire DOM against a fresh CRDT render. Used
   * when a change can't be localized to a region — a null local region (records
   * didn't resolve, e.g. an editorRoot-level replacement), initial load, or a
   * composition release. Serialize the DOM through the host hook so it's cleaned the
   * same way the CRDT render is (clean-vs-clean) — otherwise an initial load or
   * editorRoot-level replacement would bake host-internal attributes (e.g.
   * data-mce-*) straight into the CRDT.
   */
  function fullDocDiff() {
    const rogueHtml = timed("full_render", () => crdt.render() ?? "");
    const editorHtml = timed("clean_innerhtml", () => cleanInnerHtml());
    if (editorHtml === rogueHtml) {
      // Content already matches the CRDT, but we're on the unscoped full-doc path —
      // the change couldn't be localized (e.g. the sole top-level block replaced by
      // an identical clone), so node identities may have churned. Refresh the rope.
      // Rare path, and already O(n) from the render + serialize just above.
      rebuildRope();
      return;
    }
    if (applyDiff(rogueHtml, editorHtml, 0) === false) return;
    finishSync(rebuildRope);
  }

  /**
   * The editor's current DOM serialized cleanly — escaped text and host-cleaned
   * tags, matching the rope's serialization and therefore the CRDT render. Built from a
   * throwaway rope over the live DOM (the persistent rope is rebuilt separately
   * in finishSync); this only runs on the rare full-document path.
   * @returns {string}
   */
  function cleanInnerHtml() {
    const r = buildRope(editorRoot, serializeNode, omitNode, unwrapNode, opaqueNode);
    return r ? r.serialize() : "";
  }

  /** Index of the first differing char between two strings, or -1 if equal. */
  function firstDiffIx(/** @type {string} */ a, /** @type {string} */ b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : n;
  }

  /** Compare the CRDT render against the live DOM once. O(n): the public
   *  `assertConsistent()` exposes it for a diagnose button, and the debug path
   *  below uses it per settle.
   *  @returns {{ ok: boolean, crdt: string, dom: string }} */
  function checkConsistent() {
    rogue_render();
    const crdtStr = readUtf16();
    const domStr = cleanInnerHtml();
    return { ok: crdtStr === domStr, crdt: crdtStr, dom: domStr };
  }

  /**
   * Divergence detector. At a sync settle point three representations must be
   * byte-identical: the CRDT render, the persistent rope's serialization, and
   * the DOM serialized through the same clean path (`cleanInnerHtml`). The DOM
   * is browser-parsed, hence always well-formed HTML, so any mismatch means an
   * op mis-landed — offset drift or a bad rope splice. Off unless `debugSync`;
   * on a mismatch it fails loudly with a full snapshot + the first diverging
   * offset, so the triggering op is its own minimal reproducer.
   * @param {string} where Label of the settle point that ran the check.
   */
  function assertConsistent(where) {
    if (!debugSync) return;
    try {
      const { crdt, dom } = checkConsistent();
      const ropeStr = rope ? rope.serialize() : "";
      /** @type {string[]} */
      const problems = [];
      if (crdt !== dom) problems.push("crdt≠dom");
      if (ropeStr !== dom) problems.push("rope≠dom");

      // Only shout when the divergence *changes*: a sticky mismatch re-detects on
      // every settle, which buries the clean→diverged transition (and the innocent
      // edits in between) under identical repeats. Report the first occurrence and
      // any change, stay quiet on repeats, and note when it heals.
      if (!problems.length) {
        if (lastDivergenceKey) {
          console.log("%c✓ sync resynced", "color:#2a2;font-weight:bold");
          lastDivergenceKey = "";
        }
        return;
      }
      const at =
        crdt !== dom ? firstDiffIx(crdt, dom) : firstDiffIx(ropeStr, dom);
      const key = `${problems.join(",")}@${at}`;
      if (key === lastDivergenceKey) return; // same wound, already reported
      lastDivergenceKey = key;

      // The first diverging char sits right at the mis-landed op, so the slice
      // around it usually shows exactly which tag got sliced.
      const near = (/** @type {string} */ s) =>
        at < 0 ? "" : JSON.stringify(s.slice(Math.max(0, at - 24), at + 24));
      console.error(
        `%c\u{1F534} SYNC DIVERGENCE @ ${where} [${problems.join(", ")}]`,
        "color:#fff;background:#c00;font-weight:bold;padding:2px 6px",
      );
      if (at >= 0) console.error(`first diff @ vis_ix ${at}`);
      console.error("crdt near:", near(crdt));
      console.error("dom  near:", near(dom));
      console.error("rope near:", near(ropeStr));
      console.error("crdt full:", JSON.stringify(crdt));
      console.error("dom  full:", JSON.stringify(dom));
      console.error("rope full:", JSON.stringify(ropeStr));
    } catch (e) {
      console.error(`\u{1F534} sync invariant check threw @ ${where}`, e);
    }
  }

  let composing = false;
  // Remote ops that arrived while the IME held the DOM (composing). Applying
  // them mid-composition would re-render over the preedit and lose it, so we
  // queue them and drain on composition release.
  let deferredOps = /** @type {Uint8Array[]} */ ([]);

  function onPaste(/** @type {ClipboardEvent} */ e) {
    e.preventDefault();
    const html = e.clipboardData?.getData("text/html") ?? "";
    const plain = e.clipboardData?.getData("text/plain") ?? "";
    const content = html
      ? DOMPurify.sanitize(html)
      : plain
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");
    if (paste && paste.maxBytes && content.length > paste.maxBytes) {
      paste.onRejected?.(content.length, paste.maxBytes);
      return;
    }
    doc.execCommand("insertHTML", false, content);
  }

  function undo() {
    // Drain pending local edits first so undo reverts the just-typed content,
    // not a stale pre-input state.
    drainLocal();
    const result = rogueUndo(ca);
    if (!result) return;
    ca = result.nextCa;
    applyOp(result.payload);
    onCommit?.(result.payload);
    undoDepth++;
  }

  function redo() {
    drainLocal();
    if (ca === null) return; // at head — nothing to walk forward from
    if (undoDepth <= 0) return; // nothing undone to redo
    const result = rogueRedo(ca);
    if (!result) return;
    ca = result.nextCa;
    applyOp(result.payload);
    onCommit?.(result.payload);
    undoDepth--;
  }

  function onKeydown(/** @type {KeyboardEvent} */ e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (e.ctrlKey && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    }
  }

  function onCompositionStart() {
    composing = true;
  }

  // Release a composition: capture the composed text into the CRDT, then apply
  // any remote ops deferred while the IME owned the DOM. Fired on
  // compositionend and, defensively, on focusout — some browsers abandon a
  // composition without firing compositionend when the editor loses focus,
  // which would otherwise leave the lock stuck and deferred ops unapplied.
  function releaseComposition() {
    if (!composing) return;
    composing = false;
    // The observer skipped every mutation while composing, so the composed text is
    // in the DOM but not the CRDT — capture it with a full-doc diff.
    // TODO(localize-composition): fullDocDiff is O(n) and runs on every IME
    // composition, which is the common path for CJK/foreign-language users.
    // Localize it by capturing `beforeinput`'s getTargetRanges() at
    // compositionstart and diffing just that span on release.
    userEditPending = true; // composition is a user edit (IME is always user-driven)
    fullDocDiff();
    drainDeferred();
  }

  // Apply remote ops queued during composition. releaseComposition() has
  // already synced the composed text into the CRDT, so these merge on top.
  function drainDeferred() {
    if (deferredOps.length === 0) return;
    const queued = deferredOps;
    deferredOps = [];
    for (const op of queued) applyOp(op);
  }

  // Engine-initiated DOM writes (rerender / partial rerender) run through this so
  // the MutationObserver below never mistakes our own output for a user edit:
  // takeRecords() synchronously drains the mutations we just caused, before the
  // observer's microtask callback can see them.
  /** @type {MutationObserver | null} */
  let observer = null;
  /** @param {() => void} fn */
  function selfMutate(fn) {
    fn();
    observer?.takeRecords();
  }

  // Sync any user edits still sitting in the observer queue into the CRDT *before*
  // a remote op (or undo) re-renders. Without this, `selfMutate`'s takeRecords()
  // discards the pending records and the render overwrites the DOM from a CRDT
  // state that never saw the edit — the character is silently lost.
  function drainLocal() {
    const pending = observer?.takeRecords();
    if (pending && pending.length) localSync(pending);
  }

  // Sync is triggered by ALL DOM changes, not just `input`. TinyMCE mutates the
  // editor outside of input events (delayed normalization, bogus-node toggles),
  // which an input listener misses → DOM/CRDT drift. The observer catches every
  // change; during IME composition we defer (compositionend runs the sync).
  // The records tell us exactly where the DOM changed, so we scope the sync to
  // that region (localRegion) rather than re-diffing the whole doc.
  /** Compact one-line description of a node for debug logs. */
  function describeNode(/** @type {Node | null} */ n) {
    if (!n) return "∅";
    if (n.nodeType === 3)
      return `#text${JSON.stringify((/** @type {Text} */ (n)).data.slice(0, 24))}`;
    const el = /** @type {Element} */ (n);
    const id = el.id ? `#${el.id}` : "";
    const cls =
      typeof el.className === "string" && el.className
        ? `.${el.className.split(/\s+/)[0]}`
        : "";
    return `<${el.tagName?.toLowerCase()}${id}${cls}>`;
  }

  /**
   * A mutation wholly inside an opaque element is the host's local business: the
   * rope tracks only the shell, so there is nothing to diff and nothing to
   * commit. Resolving a region there would also throw — the parent was never
   * tokenized. Attribute changes on the shell *itself* do sync, so those are not
   * filtered.
   * @param {MutationRecord} rec
   */
  function opaqueLocalMutation(rec) {
    const from = rec.type === "attributes" ? rec.target.parentNode : rec.target;
    for (let n = from; n && n !== editorRoot; n = n.parentNode) {
      if (n.nodeType === 1 /* ELEMENT_NODE */ && opaqueNode(/** @type {Element} */ (n))) return true;
    }
    return false;
  }

  /**
   * The local path's top level (symmetric with applyOp): the observer's batch of
   * MutationRecords → the touched region → a scoped CRDT diff. The records
   * authoritatively bound the DOM change, so a resolved region is the whole story —
   * diff it (a clean-equal diff means the mutation was pure noise, e.g. a data-mce-*
   * toggle → no op). A null region means the records didn't resolve (empty rope, or
   * an editorRoot-level replacement) → full-doc diff.
   * @param {MutationRecord[]} records
   */
  function localSync(records) {
    // During initial bootstrap (beginLoad → endLoad) the host toggles editor
    // chrome — e.g. TinyMCE's mode.set('readonly') flips the body's
    // contenteditable/class attributes — which the observer would otherwise
    // diff against the *empty* CRDT and absorb the editor's initial empty block
    // as content (a stray <p><br></p> prepended on every load). Suppress the
    // observer while loading; ops arrive via mergeOp, not the DOM.
    if (loading) return;
    if (composing) return;
    // Drop mutations inside opaque subtrees (they can't affect the CRDT). If
    // that was the whole batch, there is nothing left to sync.
    const relevant = records.filter((r) => !opaqueLocalMutation(r));
    if (relevant.length === 0) return;
    // Debug/bisect knob: force the whole-document diff path (skip scoped region
    // resolution) to isolate whether a divergence lives in the surgical local
    // diff or deeper. See __rogueForceFullSync at the createRogueNode top.
    const region = forceFullSync() ? null : localRegion(relevant);
    if (debugSync) {
      // Raw mutations + the region they resolved to. On a clean→diverged transition,
      // this shows whether a chrome removal (a) never appeared as a record (lost),
      // (b) appeared but fell outside the resolved region (scoping bug), or (c) was
      // in region but still not diffed out (offset/apply bug).
      console.log(
        "%c[mut]",
        "color:#a5f;font-weight:bold",
        relevant.map((r) =>
          r.type === "childList"
            ? `childList @${describeNode(r.target)} +[${[...r.addedNodes].map(describeNode).join(", ")}] −[${[...r.removedNodes].map(describeNode).join(", ")}]`
            : `${r.type} @${describeNode(r.target)}${r.attributeName ? ` (${r.attributeName})` : ""}`,
        ),
        "→",
        region
          ? `region[${region.startVisIx}] ${describeNode(region.before)}…${describeNode(region.after)}`
          : "null → full-doc",
      );
    }
    timed("sync_total", () => (region ? diffToCrdt(region) : fullDocDiff()));
  }

  function onSelectionChange() {
    if (programmaticSelection) return;
    if (!editorRoot.contains(win.getSelection()?.anchorNode ?? null)) return;
    if (pendingSelectionSave) win.cancelAnimationFrame(pendingSelectionSave);
    pendingSelectionSave = win.requestAnimationFrame(() => {
      pendingSelectionSave = null;
      const ids = saveCursor();
      if (ids) cursorIds = ids;
    });
  }

  if (paste !== false) editorRoot.addEventListener("paste", onPaste);
  editorRoot.addEventListener("keydown", onKeydown);
  editorRoot.addEventListener("compositionstart", onCompositionStart);
  editorRoot.addEventListener("compositionend", releaseComposition);
  editorRoot.addEventListener("focusout", releaseComposition);
  doc.addEventListener("selectionchange", onSelectionChange);

  // Use the host window's MutationObserver so it observes nodes in that realm
  // (e.g. TinyMCE's iframe document).
  const obs = /** @type {MutationObserver} */ (
    new /** @type {any} */ (win).MutationObserver(localSync)
  );
  obs.observe(editorRoot, {
    childList: true,
    characterData: true,
    attributes: true,
    subtree: true,
  });
  observer = obs;

  // Debug helpers — accessible from the browser console as `win.rogue.*`,
  // i.e. `window.rogue` for standalone and `editor.getWin().rogue` for
  // TinyMCE-hosted instances.
  // @ts-ignore
  win.rogue = {
    editorRoot: () => editorRoot,
    rope: () => rope,
    visLen: () => rogue_vis_len(),
    idAt: (/** @type {number} */ visIx) => {
      if (!rogue_id_at(visIx)) return null;
      return readUtf8();
    },
    visIx: (/** @type {string} */ id) => {
      const n = rogue_vis_ix(writeUtf8(id));
      return n < 0 ? null : n;
    },
    prevVis: (/** @type {string} */ id) => {
      const f = rogue_prev_vis(writeUtf8(id));
      return f ? readUtf8() : null;
    },
    nextVis: (/** @type {string} */ id) => {
      const f = rogue_next_vis(writeUtf8(id));
      return f ? readUtf8() : null;
    },
    saveCursor: () => saveCursor(),
    cursorIds: () => cursorIds,
    render: () => {
      rogue_render();
      return readUtf16();
    },
  };

  // Ops that arrived before their parents (rogue_merge returned 0 →
  // UnknownParent). Each successful merge can unblock zero or more of
  // these; we sweep the queue until no more progress. Bounded by
  // PARKED_CAP — overflow is reported via console.error rather than silently
  // dropping, since silent drops here are exactly the bug this whole mechanism
  // exists to fix.
  /** @type {Uint8Array[]} */
  const parkedOps = [];
  const PARKED_CAP = 10_000;

  /** Ops dropped at PARKED_CAP. Non-zero means our history is known-incomplete. */
  let parkedDropped = 0;

  /** @typedef {{ replica: number, seq: number }} Gid */

  /** The group id of a multi_op_v0 payload.
   *  @param {Uint8Array} payload @returns {Gid} */
  function gidOf(payload) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return { replica: view.getUint16(0, true), seq: view.getUint32(2, true) };
  }

  /** @param {Gid} gid @returns {string} */
  function gidKey(gid) {
    return `${gid.replica}:${gid.seq}`;
  }

  /** Compare group ids in (seq, replica) order.
   *  @param {Gid} a @param {Gid} b @returns {number} */
  function cmpGid(a, b) {
    return a.seq - b.seq || a.replica - b.replica;
  }

  /** Group ids of ops that were rejected (produced invalid HTML). */
  const rejected = new Set();

  /** Applied groups, sorted by (seq, replica) — the fold order. */
  let appliedGroups = /** @type {{ gid: Gid, payload: Uint8Array }[]} */ ([]);

  /** Total payload bytes in appliedGroups, maintained so stats() stays O(1). */
  let appliedBytes = 0;

  /** Keys of appliedGroups, for O(1) idempotency. */
  const appliedKeys = new Set();

  /** The largest applied group id (for the at-head fast path). */
  let maxGid = /** @type {Gid | null} */ (null);

  /** Record an applied group so the fold can re-merge it later. Idempotent.
   *  @param {Gid} gid @param {Uint8Array} payload */
  function trackApplied(gid, payload) {
    const key = gidKey(gid);
    if (appliedKeys.has(key)) return;
    appliedGroups.push({ gid, payload });
    appliedBytes += payload.byteLength;
    appliedKeys.add(key);
    if (!maxGid || cmpGid(gid, maxGid) > 0) maxGid = gid;
  }

  /** Drop the last tracked group, keeping appliedBytes in step.
   *  @returns {{ gid: Gid, payload: Uint8Array } | undefined} */
  function untrackLast() {
    const g = appliedGroups.pop();
    if (g) appliedBytes -= g.payload.byteLength;
    return g;
  }

  /** Drop (and return) the groups from `idx` on, keeping appliedBytes in step.
   *  @param {number} idx */
  function untrackFrom(idx) {
    const removed = appliedGroups.splice(idx);
    for (const g of removed) appliedBytes -= g.payload.byteLength;
    return removed;
  }

  /** Attempt all parked ops. Returns true if any were merged.
   *
   *  Ops whose gid is below the head must go through applyOp's ordering path
   *  (revert the tail, insert in (seq, replica) order, replay), NOT be merged
   *  directly: appending them would leave the CRDT's group_order unsorted, and
   *  revertTail would then unwind the wrong groups.
   */
  function drainParked() {
    if (draining) return false;
    draining = true;
    let any = false;
    try {
      let progress = true;
      while (progress) {
        progress = false;
        const queue = parkedOps.splice(0);
        let processed = 0;
        try {
          for (; processed < queue.length; processed++) {
            const payload = queue[processed];
            const key = gidKey(gidOf(payload));
            applyOp(payload);
            if (appliedKeys.has(key)) {
              any = true;
              progress = true;
            }
          }
        } catch (err) {
          // applyOp can call host hooks that throw. Restore everything not yet
          // attempted (including the one that threw — applyOp is idempotent), so
          // a host exception can't silently drop the parked queue.
          parkedOps.unshift(...queue.slice(processed));
          throw err;
        }
      }
    } finally {
      draining = false;
    }
    return any;
  }

  /** Surface (loudly) that the parked-ops cap was hit and a payload is
   *  being dropped. CRDT state up to this point is consistent but
   *  incomplete; the right app-level response is to prompt a reload.
   *  @param {Uint8Array} payload */
  function reportParkedOverflow(payload) {
    parkedDropped += 1;
    console.error(
      `[rogue] parked-ops cap (${PARKED_CAP}) exceeded — incoming op dropped. ` +
        `CRDT state is now incomplete; client should reload to re-sync.`,
      { cap: PARKED_CAP, currentParked: parkedOps.length, payloadSize: payload.byteLength },
    );
  }

  /**
   * Apply an op with partial re-rendering: only update the smallest
   * DOM element that contains the affected range.
   *
   * If the op can't be merged yet (parent NodeId not present — typically
   * because it came from a different source and arrived before its
   * dependency), the payload is parked and retried on every subsequent
   * successful merge. Callers see mergeOp as best-effort; the engine
   * eventually applies whatever it can.
   *
   * Falls back to full rerender if partial can't be determined.
   * @param {Uint8Array} payload
   * @param {boolean} [forceHead] Treat the op as at-head even if its gid sorts
   *   before `maxGid`. Used when replaying a reverted tail in application order
   *   (recoverLoad): the ops were already applied, so they must merge, validate
   *   and render in that order rather than re-entering the out-of-order path.
   */
  function applyOp(payload, forceHead = false) {
    // Drain pending local edits before merging a remote op (see drainLocal).
    drainLocal();

    const gid = gidOf(payload);
    const key = gidKey(gid);
    if (rejected.has(key)) return;
    if (appliedKeys.has(key)) return;

    // The op's affected region, as an escalation of levels from tightest up to
    // the whole top-level block. Used by both the partial render and the
    // localized round-trip check. Null during bootstrap (the DOM rope is stale)
    // and for whole-doc ops.
    const opBounds = loading ? null : crdt.visIxBounds(payload);
    const regionLevels = opBounds ? dom.regionForVisBounds(opBounds) : null;
    const atHead = forceHead || !maxGid || cmpGid(gid, maxGid) > 0;

    if (atHead) {
      // Merge the incoming op. 0 → park (dependency missing); -1 → drop
      // (permanently malformed: group_id doesn't match its ops).
      const merged = crdt.merge(payload);
      if (merged === 0) {
        if (parkedOps.length < PARKED_CAP) parkedOps.push(payload);
        else reportParkedOverflow(payload);
        return;
      }
      if (merged < 0) {
        // Permanently malformed or at-capacity — it can never apply, so drop it
        // loudly rather than silently. The WASM wrote a structured error.
        const err = readCrdtError();
        console.error("[sync] dropping un-mergeable op", gid, err);
        onError?.(err ?? { type: -1, name: "unknown" });
        return;
      }
      const prevMax = maxGid;
      trackApplied(gid, payload);

      // Validate + render. renderOp walks the scopes (tight → top-level block),
      // swapping at the first whose html balances; falling through every scope is
      // the signal the merged content is invalid HTML → reject (revert). Whole-doc
      // and forced-full ops validate the full render directly. On reject the DOM
      // was never mutated (renderOp only swaps on success), so no re-render needed.
      // Bootstrap (loading) merges unvalidated; endLoad validates the final render
      // once and walks back on failure (recoverLoad).
      let rejectedOp = false;
      if (!loading) {
        if (regionLevels && !forceFullSync()) {
          rejectedOp = !dom.renderOp(regionLevels);
        } else if (validateHtml(crdt.render() ?? "", editorRoot)) {
          dom.fullRender();
        } else {
          rejectedOp = true;
        }
      }

      if (rejectedOp) {
        crdt.revertTail(1);
        rejected.add(key);
        appliedKeys.delete(key);
        untrackLast();
        maxGid = prevMax;
      }

      // Incoming op may have unblocked parked ops — drain them (full render if any
      // applied).
      if (!loading && !booting && drainParked()) dom.fullRender();
    } else {
      // Out-of-order: the incoming op sorts somewhere before the current head.
      // Only the tail (the groups that now sort after it) needs to be un-applied
      // and re-played — the head stays put. Capture the tail's region while
      // DOM/rope/CRDT still agree, revert the tail in place, restore the head into
      // that region, then replay the incoming op + tail through the at-head path.
      trackApplied(gid, payload);
      appliedGroups.sort((a, b) => cmpGid(a.gid, b.gid));
      const idx = appliedGroups.findIndex(
        (g) => g.gid.replica === gid.replica && g.gid.seq === gid.seq,
      );

      const tailCount = appliedGroups.length - idx - 1;
      const tailRegion =
        tailCount > 0 && !loading
          ? dom.regionForVisBounds(tailVisBounds(appliedGroups, idx + 1))
          : null;

      // Un-apply the tail in place, then rewind the fold bookkeeping to the head so
      // the replayed ops re-track through the normal at-head path.
      crdt.revertTail(tailCount);
      const replay = untrackFrom(idx);
      for (const g of replay) appliedKeys.delete(gidKey(g.gid));
      maxGid = appliedGroups.length
        ? appliedGroups[appliedGroups.length - 1].gid
        : null;

      // Restore the head (tail now reverted) into the captured region, so DOM and
      // rope agree with the CRDT before the replay.
      if (!loading) {
        if (tailRegion) dom.renderOp(tailRegion);
        else dom.fullRender();
      }

      // Replay the incoming op + tail in sorted order. Each is now "at head", so it
      // flows through the normal merge → localized round-trip → surgical render path.
      for (const g of replay) applyOp(g.payload);

      const drained = !booting && drainParked();
      if (!loading && drained) dom.fullRender();
    }

    if (!loading) {
      restoreCursor(cursorIds);
      assertConsistent("mergeOp");
      // Fire onChange after the render (remote op / undo / redo) so anchored
      // ranges can re-resolve against the updated DOM. Out-of-order replay fires
      // it once per replayed op too — idempotent for consumers. Suppressed while
      // endLoad replays a walk-back tail (a load should settle once).
      if (!booting) onChange?.(opBounds);
    }

    maybeWarnSize();
  }

  /**
   * The merged bootstrap log renders invalid HTML. Walk back from the fold-order
   * tail until the prefix renders valid; the last popped op is the boundary
   * ("dirty"). Drop it, then replay the remaining popped ops through applyOp,
   * which validates each op and rejects any further bad ones.
   *
   * This is the deliberate "the full render is valid" semantic (see
   * docs/plan-load-walkback.md): an op that is invalid at its own prefix but valid
   * once later ops arrive is accepted. The ordinary conflict path — where the bad
   * op keeps the final render invalid — still matches per-op rejection.
   */
  function recoverLoad() {
    // `appliedGroups` is kept in CRDT application order — the order `revertTail`
    // unwinds — so walk it as stored. Sorting by gid would break the 1:1
    // correspondence with the CRDT's `group_order` once dependent ops have been
    // parked or replayed (application order is not gid order).
    /** @type {{ gid: Gid, payload: Uint8Array }[]} */
    const popped = [];
    /** @type {{ gid: Gid, payload: Uint8Array } | null} */
    let dirty = null;

    while (appliedGroups.length > 0) {
      const g = /** @type {{ gid: Gid, payload: Uint8Array }} */ (untrackLast());
      const reverted = crdt.revertTail(1);
      appliedKeys.delete(gidKey(g.gid));
      popped.push(g);
      if (reverted !== 1) {
        // The CRDT could not unwind the group we popped: the ledger and the
        // engine disagree. Surface it; the guard below logs and replays.
        console.error("[sync] load recovery revert mismatch", { gid: g.gid, reverted });
        onError?.({ type: -1, name: "load_recovery_failed" });
        break;
      }
      if (validateHtml(crdt.render() ?? "", editorRoot)) {
        dirty = g;
        break;
      }
    }

    if (!dirty) {
      // The empty document always validates, so reaching here means a revert did
      // not line up with the ledger. Surface it rather than silently installing a
      // still-invalid render.
      console.error("[sync] load recovery found no valid prefix", { popped: popped.length });
      onError?.({ type: -1, name: "load_recovery_failed" });
    } else {
      rejected.add(gidKey(dirty.gid));
    }

    // Application order is not gid order, so the head is the max over the prefix.
    maxGid = null;
    for (const g of appliedGroups) {
      if (!maxGid || cmpGid(g.gid, maxGid) > 0) maxGid = g.gid;
    }

    // Render the valid prefix, then replay the tail (oldest first) without the
    // boundary op. forceHead skips the gid-based out-of-order path: these ops were
    // already applied, so they merge/validate/render in their original order.
    dom.forceFullRender();
    popped.reverse();
    if (dirty) popped.shift();

    booting = true;
    try {
      for (const g of popped) applyOp(g.payload, true);
      // The tail is replayed in order, so appliedGroups is gid-sorted again; only
      // now is it safe to drain (a drain can reorder application order).
      if (drainParked()) dom.fullRender();
    } finally {
      booting = false;
    }
  }

  // ── Observability ─────────────────────────────────────────────────────────
  // Cheap values for a host to poll (a status bar, a recovery panel, a warning
  // banner). Nothing here mutates the doc; destructive repair belongs server-side.

  /** @type {Record<string, boolean>} */
  const warnArmed = {};

  /** O(1) size/integrity snapshot. @returns {NodeStats} */
  function stats() {
    return {
      visLen: crdt.visLen(),
      ops: appliedGroups.length,
      opBytes: appliedBytes,
      crdtBytes: rogue_used_bytes(),
      parked: parkedOps.length,
      parkedDropped,
    };
  }

  /** Fire onSizeWarning when a sizeWarn metric first crosses its threshold;
   *  re-arm once it falls back below half, so undo/delete doesn't re-fire on
   *  every subsequent op. O(1) per applied op — no counters to scan. */
  function maybeWarnSize() {
    if (!sizeWarn) return;
    /** @type {NodeStats | null} */
    let snapshot = null;
    for (const key of /** @type {const} */ (["ops", "opBytes", "crdtBytes"])) {
      const limit = sizeWarn[key];
      if (!limit) continue;
      snapshot ??= stats();
      if (snapshot[key] >= limit) {
        if (!warnArmed[key]) {
          warnArmed[key] = true;
          onSizeWarning?.(snapshot, key);
        }
      } else if (snapshot[key] < limit * 0.5) {
        warnArmed[key] = false;
      }
    }
  }

  /** The document's current value as a string. The CRDT is markup-agnostic —
   *  HTML is only a host convention (svg-edit stores raw SVG through the same
   *  node) — hence getString(), not getHtml(). O(n): it renders the whole doc. */
  function getString() {
    return crdt.render() ?? "";
  }

  /** Every applied op payload, in application order, for diagnosis/export.
   *  The payloads are the live multi_op_v0 buffers — read-only, do not mutate.
   *  O(n). Client-side deletion is deliberately not offered: removing history
   *  has to happen where the other replicas agree with it (the server). */
  function exportOps() {
    return appliedGroups.map(({ gid, payload }) => ({
      gid: { replica: gid.replica, seq: gid.seq },
      payload,
    }));
  }

  return {
    mergeOp(payload) {
      // Defer remote ops while the IME owns the DOM; applying now would
      // re-render over the in-progress composition and lose it. Drained on
      // composition release (compositionend / focusout).
      if (composing) {
        deferredOps.push(payload);
        return;
      }
      applyOp(payload);
    },

    /** Enter bootstrap mode: subsequent mergeOp calls merge into the CRDT but
     *  neither render nor validate per op. Call endLoad() once the initial sync
     *  has fully loaded; it validates the final render once. */
    beginLoad() {
      loading = true;
    },

    /** Exit bootstrap mode: validate the now-complete CRDT once and render it.
     *  If the final render is invalid, walk back to the last good prefix, drop the
     *  boundary op, and replay the tail (recoverLoad). Idempotent. */
    endLoad() {
      if (!loading) return;
      loading = false;
      // Do NOT drain parked ops here: a parked op's gid can sort below the head,
      // and appending it to the CRDT's application-order stack would break the
      // sorted-tail assumption the out-of-order path relies on. Parked ops are
      // drained by the next live applyOp instead (as before).
      if (!validateHtml(crdt.render() ?? "", editorRoot)) {
        recoverLoad();
        return;
      }
      dom.forceFullRender();
    },

    /** Pre-grow the CRDT storage to ~`nodes` (from a sync size hint) so a big
     *  doc loads in one shot instead of realloc'ing as ops stream in. The
     *  estimate is rough — the engine still grows on demand as a backstop. */
    reserve(/** @type {number} */ nodes) {
      if (nodes > 0) rogue_reserve(nodes);
    },

    /** O(1) size/integrity numbers (see NodeStats). Cheap enough to poll. */
    stats,

    /** The document's current value as a string. O(n). */
    getString,

    /** Applied op payloads, in application order, for diagnosis/export. O(n). */
    exportOps,

    /** Compare the CRDT render against the live DOM on demand. O(n). */
    assertConsistent: checkConsistent,

    /** Switch the stamping identity for subsequent local ops. Lets one node emit
     *  ops under several replica ids — e.g. a shared server-side replica serving
     *  many agent connections. Each author gets its own monotonic sequence,
     *  seeded from the shared clock; ids must be unique per doc and unused by any
     *  other writer. Throws on allocation failure. */
    setAuthor(/** @type {number} */ author) {
      if (!rogue_set_author(author)) throw new Error("rogue_set_author failed — out of memory");
    },

    undo,
    redo,

    /** Drain parked ops and rerender if any applied. */
    drainParked() {
      if (drainParked()) dom.fullRender();
    },

    /** Flip the divergence detector on/off at runtime (default: ?debug=sync). */
    setSyncDebug(/** @type {boolean} */ on) {
      debugSync = !!on;
      rogue_set_debug_logging(on ? 1 : 0);
    },

    /** Mark the next local commit as a genuine user edit so it resets the undo
     *  frontier. The host calls this from its own "this is a user edit" signal
     *  (e.g. TinyMCE's `BeforeAddUndo`); commits without it are treated as host
     *  normalization and leave the frontier alone. */
    markUserEdit() {
      userEditPending = true;
    },

    // ── Annotation surface (comments/suggestions) ──────────────────────────
    // Node-id ⇄ vis-index resolution for anchoring annotations to stable CRDT
    // ids, plus the DOM rope for vis-index ⇄ DOM-position mapping. Read-only
    // helpers only — all mutation goes through mergeOp/undo/redo so the render
    // stays consistent with the CRDT.
    crdt: {
      /** @param {string} id @returns {number | null} */
      visIxOf: (id) => crdt.visIxOf(id),
      /** @param {number} ix @returns {string | null} */
      idAtVisIx: (ix) => crdt.idAtVisIx(ix),
      /** @param {string} id @returns {string | null} */
      nextVisId: (id) => crdt.nextVisId(id),
      /** @param {string} id @returns {string | null} */
      prevVisId: (id) => crdt.prevVisId(id),
      /** @returns {number} */
      visLen: () => crdt.visLen(),
    },

    /** The DOM rope (vis-index ⇄ DOM-position mapping). Rebuilt in place after
     *  each render; the instance reference stays stable across rebuilds. */
    rope,

    destroy() {
      if (paste !== false) editorRoot.removeEventListener("paste", onPaste);
      editorRoot.removeEventListener("keydown", onKeydown);
      editorRoot.removeEventListener("compositionstart", onCompositionStart);
      editorRoot.removeEventListener("compositionend", releaseComposition);
      editorRoot.removeEventListener("focusout", releaseComposition);
      doc.removeEventListener("selectionchange", onSelectionChange);
      observer?.disconnect();
      rogue_deinit();
    },
  };
}
