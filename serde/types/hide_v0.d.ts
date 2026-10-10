/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 * @typedef {{ id: NodeId, target: NodeId, len: number }} Hide
 */
/**
 * Encode a hide payload. Returns a fresh 16-byte Uint8Array.
 * @param {Hide} hide
 * @returns {Uint8Array}
 */
export function encode(hide: Hide): Uint8Array;
/**
 * @param {Uint8Array} buf
 * @returns {Hide}
 */
export function decode(buf: Uint8Array): Hide;
export const DISC: 1;
export const SIZE: 16;
export type NodeId = {
    replica_id: number;
    sequence: number;
};
export type Hide = {
    id: NodeId;
    target: NodeId;
    len: number;
};
