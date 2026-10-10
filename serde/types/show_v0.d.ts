/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 * @typedef {{ id: NodeId, target: NodeId, len: number }} Show
 */
/**
 * @param {Show} show
 * @returns {Uint8Array}
 */
export function encode(show: Show): Uint8Array;
/**
 * @param {Uint8Array} buf
 * @returns {Show}
 */
export function decode(buf: Uint8Array): Show;
export const DISC: 2;
export const SIZE: 16;
export type NodeId = {
    replica_id: number;
    sequence: number;
};
export type Show = {
    id: NodeId;
    target: NodeId;
    len: number;
};
