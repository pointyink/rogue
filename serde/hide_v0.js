// @ts-check
//
// hide_v0 — fixed-shape (16 byte) CRDT hide op. See `hide_v0.md`.
// Payload: id(6) + target(6) + len(4). Identical wire shape to show_v0;
// the discriminator carries the semantic difference.

import * as nodeIdV0 from './node_id_v0.js'

export const DISC = 1
export const SIZE = 16

/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 * @typedef {{ id: NodeId, target: NodeId, len: number }} Hide
 */

/**
 * Encode a hide payload. Returns a fresh 16-byte Uint8Array.
 * @param {Hide} hide
 * @returns {Uint8Array}
 */
export function encode(hide) {
  const buf = new Uint8Array(SIZE)
  const view = new DataView(buf.buffer)
  nodeIdV0.encode(hide.id, view, 0)
  nodeIdV0.encode(hide.target, view, 6)
  view.setUint32(12, hide.len, true)
  return buf
}

/**
 * @param {Uint8Array} buf
 * @returns {Hide}
 */
export function decode(buf) {
  if (buf.byteLength < SIZE) throw new Error('hide_v0: truncated')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return {
    id: nodeIdV0.decode(view, 0),
    target: nodeIdV0.decode(view, 6),
    len: view.getUint32(12, true),
  }
}
