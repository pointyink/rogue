/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 */
/**
 * Writes 6 little-endian bytes at `offset`: u16 replica_id, then u32 sequence.
 * @param {NodeId} id
 * @param {DataView} view
 * @param {number} offset
 */
export function encode(id: NodeId, view: DataView, offset: number): void;
/**
 * Reads 6 little-endian bytes at `offset` into a NodeId.
 * @param {DataView} view
 * @param {number} offset
 * @returns {NodeId}
 */
export function decode(view: DataView, offset: number): NodeId;
export const SIZE: 6;
export type NodeId = {
    replica_id: number;
    sequence: number;
};
