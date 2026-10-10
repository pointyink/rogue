// @ts-check
//
// Cross-tab op relay for one doc. Every tab applies its own ops locally and
// broadcasts them to sibling tabs over a BroadcastChannel, so siblings merge
// them immediately (advancing their Lamport clocks) instead of waiting for the
// WebSocket round-trip.
//
// This is what makes concurrent multi-tab writes safe *in practice*: only one
// tab has keyboard focus at a time, and the broadcast lands in ~ms — far faster
// than a human can switch tabs and type — so a sibling's clock is caught up
// before it can mint a colliding `(replica, seq)` id. There is no single-writer
// lock: the residual race is vanishingly thin, and reintroducing a leader
// election (if ever needed) is an additive change on top of this relay.
//
// The op still goes over the normal WS path for durability; the broadcast is a
// fast preview that only converges clocks. Idempotent via the CRDT's op_index.

/**
 * @typedef {{
 *   docId: string,
 *   onOp: (payload: Uint8Array) => void,
 * }} DocBusOptions
 *
 * @typedef {{
 *   broadcastOp: (payload: Uint8Array) => void,
 *   destroy: () => void,
 * }} DocBus
 */

/**
 * @param {DocBusOptions} options
 * @returns {DocBus}
 */
export function createDocBus({ docId, onOp }) {
  const channel = new BroadcastChannel(`rogue:doc:${docId}`)
  channel.onmessage = (e) => {
    const msg = e.data
    if (msg?.type === 'op') {
      try {
        onOp(msg.payload)
      } catch {
        // Fast-path merge raced ahead of the op's dependencies — the WS will
        // deliver it in order; ignore here.
      }
    }
  }
  return {
    /** Broadcast a locally-minted op to sibling tabs. */
    broadcastOp(payload) {
      channel.postMessage({ type: 'op', payload })
    },
    destroy() {
      channel.close()
    },
  }
}
