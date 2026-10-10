/**
 * @param {number} count
 * @returns {number}
 */
export function encodedSize(count: number): number;
/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 */
/**
 * @param {NodeId[]} groupIds
 * @returns {Uint8Array}
 */
export function encode(groupIds: NodeId[]): Uint8Array;
/**
 * @param {Uint8Array} buf
 * @returns {{ group_ids: NodeId[] }}
 */
export function decode(buf: Uint8Array): {
    group_ids: NodeId[];
};
export const DISC: 4;
export const HEADER_SIZE: 4;
export type NodeId = {
    replica_id: number;
    sequence: number;
};
