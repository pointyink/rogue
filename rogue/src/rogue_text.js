// Headless Rogue CRDT — text-only API over the WASM module.
//
// Mirrors the surface of Yjs `Y.Text` and Loro `LoroText` (insert, delete,
// length, toString) so the same benchmark/test code works across libraries.
// No DOM, no DMP, no editor wiring.

import wasmBase64 from './rogue.wasm.js'

// The bundled wasm (base64) is decoded lazily on first use.
/** @type {Uint8Array | undefined} */
let cachedWasmBytes;
function defaultWasmBytes() {
  cachedWasmBytes ??= Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0))
  return cachedWasmBytes
}

export class RogueText {
  /**
   * @param {object} [opts]
   * @param {Uint8Array} [opts.wasmBytes]  Raw rogue.wasm bytes. Auto-loaded from
   *   the package's bundled wasm if omitted.
   * @param {number}     [opts.replicaId=1]
   * @param {number}     [opts.capacity=1 << 20]  Max nodes the doc can hold.
   * @returns {Promise<RogueText>}
   */
  static async create({ wasmBytes, replicaId = 1, capacity = 1 << 20 } = {}) {
    wasmBytes ??= defaultWasmBytes();
    let mem;
    const { instance } = await WebAssembly.instantiate(/** @type {BufferSource} */ (wasmBytes), {
      env: { jsLog: () => {} },
    });
    const exp = /** @type {any} */ (instance.exports);
    mem = exp.memory;
    if (!exp.rogue_init(replicaId, capacity)) {
      throw new Error('rogue_init failed — out of memory allocating the CRDT');
    }
    return new RogueText(exp, mem);
  }

  /**
   * @param {any} exp WASM exports (untyped numeric ABI).
   * @param {WebAssembly.Memory} mem
   */
  constructor(exp, mem) {
    this._exp = exp;
    this._mem = mem;
    this._inPtr = exp.rogue_in_ptr();
    this._outPtr = exp.rogue_out_ptr();
    // Mirrors visible length so reads don't cross the WASM boundary.
    // Local ops keep this in sync; callers applying remote ops must invalidate
    // via `_syncLength()` (added once merge() is exposed).
    this._length = 0;
  }

  /** Visible length in UTF-16 code units. */
  get length() {
    return this._length;
  }

  /** Insert `str` at visible index `idx`. @param {number} idx @param {string} str */
  insert(idx, str) {
    const view = new Uint16Array(this._mem.buffer, this._inPtr, str.length);
    for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i);
    this._exp.rogue_insert(idx, 0, str.length * 2);
    this._length += str.length;
  }

  /** Tombstone `len` code units starting at visible index `idx`. @param {number} idx @param {number} len */
  delete(idx, len) {
    this._exp.rogue_hide(idx, len);
    this._length -= len;
  }

  /** Materialize the current visible text. */
  toString() {
    this._exp.rogue_render();
    const byteLen = this._exp.rogue_out_len();
    return new TextDecoder('utf-16le').decode(
      new Uint8Array(this._mem.buffer, this._outPtr, byteLen),
    );
  }
}
