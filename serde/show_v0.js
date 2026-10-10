// @ts-check
//
// show_v0 — fixed-shape (16 byte) CRDT show op. See `show_v0.md`.
// Same wire shape as hide_v0; the discriminator carries the difference.

import * as nodeIdV0 from './node_id_v0.js'

export const DISC = 2
export const SIZE = 16

/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 * @typedef {{ id: NodeId, target: NodeId, len: number }} Show
 */

/**
 * @param {Show} show
 * @returns {Uint8Array}
 */
export function encode(show) {
  const buf = new Uint8Array(SIZE)
  const view = new DataView(buf.buffer)
  nodeIdV0.encode(show.id, view, 0)
  nodeIdV0.encode(show.target, view, 6)
  view.setUint32(12, show.len, true)
  return buf
}

/**
 * @param {Uint8Array} buf
 * @returns {Show}
 */
export function decode(buf) {
  if (buf.byteLength < SIZE) throw new Error('show_v0: truncated')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return {
    id: nodeIdV0.decode(view, 0),
    target: nodeIdV0.decode(view, 6),
    len: view.getUint32(12, true),
  }
}
