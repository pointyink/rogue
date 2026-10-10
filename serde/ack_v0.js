// @ts-check
//
// ack_v0 — variable-shape server → client durability ack. See `ack_v0.md`.
// Payload: count(4) + N × node_id_v0.

import * as nodeIdV0 from './node_id_v0.js'

export const DISC = 4
export const HEADER_SIZE = 4

/**
 * @param {number} count
 * @returns {number}
 */
export function encodedSize(count) {
  return HEADER_SIZE + nodeIdV0.SIZE * count
}

/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 */

/**
 * @param {NodeId[]} groupIds
 * @returns {Uint8Array}
 */
export function encode(groupIds) {
  const buf = new Uint8Array(encodedSize(groupIds.length))
  const view = new DataView(buf.buffer)
  view.setUint32(0, groupIds.length, true)
  let off = HEADER_SIZE
  for (const id of groupIds) {
    nodeIdV0.encode(id, view, off)
    off += nodeIdV0.SIZE
  }
  return buf
}

/**
 * @param {Uint8Array} buf
 * @returns {{ group_ids: NodeId[] }}
 */
export function decode(buf) {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error('ack_v0: truncated header')
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = view.getUint32(0, true)
  const need = HEADER_SIZE + nodeIdV0.SIZE * count
  if (need > buf.byteLength) {
    throw new Error('ack_v0: truncated ids')
  }
  const ids = new Array(count)
  for (let i = 0; i < count; i++) {
    ids[i] = nodeIdV0.decode(view, HEADER_SIZE + i * nodeIdV0.SIZE)
  }
  return { group_ids: ids }
}
