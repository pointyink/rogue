/**
 * @param {string} name
 * @returns {number}
 */
export function sideFromString(name: string): number;
/**
 * @param {number} disc
 * @returns {'left' | 'right' | 'root'}
 */
export function sideToString(disc: number): "left" | "right" | "root";
/**
 * @param {number} charCount
 * @returns {number}
 */
export function encodedSize(charCount: number): number;
/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 * @typedef {{ id: NodeId, parent: NodeId, side: number, chars: Uint16Array }} Insert
 */
/**
 * Encode an insert payload. Returns a fresh Uint8Array.
 * @param {NodeId} id
 * @param {NodeId} parent
 * @param {number} side  one of `Side.Left`/`Right`/`Root`
 * @param {Uint16Array | number[]} chars
 * @returns {Uint8Array}
 */
export function encode(id: NodeId, parent: NodeId, side: number, chars: Uint16Array | number[]): Uint8Array;
/**
 * Decode an insert payload.
 * @param {Uint8Array} buf
 * @returns {Insert}
 */
export function decode(buf: Uint8Array): Insert;
export const DISC: 0;
export type Side = number;
/** @enum {number} */
export const Side: Readonly<{
    Left: 0;
    Right: 1;
    Root: 2;
}>;
export const HEADER_SIZE: 17;
export type NodeId = {
    replica_id: number;
    sequence: number;
};
export type Insert = {
    id: NodeId;
    parent: NodeId;
    side: number;
    chars: Uint16Array;
};
