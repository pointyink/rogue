// @ts-check
//
// node_id_v0 — shared primitive codec. See `node_id_v0.md` for the spec.
//
// Embedded inside discriminated op types; never appears standalone on the
// wire. Operates on a DataView at a caller-supplied byte offset so the
// parent codec controls allocation and layout.

export const SIZE = 6

/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 */

/**
 * Writes 6 little-endian bytes at `offset`: u16 replica_id, then u32 sequence.
 * @param {NodeId} id
 * @param {DataView} view
 * @param {number} offset
 */
export function encode(id, view, offset) {
  view.setUint16(offset, id.replica_id, true)
  view.setUint32(offset + 2, id.sequence, true)
}

/**
 * Reads 6 little-endian bytes at `offset` into a NodeId.
 * @param {DataView} view
 * @param {number} offset
 * @returns {NodeId}
 */
export function decode(view, offset) {
  return {
    replica_id: view.getUint16(offset, true),
    sequence: view.getUint32(offset + 2, true),
  }
}
