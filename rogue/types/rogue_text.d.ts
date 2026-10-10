export class RogueText {
    /**
     * @param {object} [opts]
     * @param {Uint8Array} [opts.wasmBytes]  Raw rogue.wasm bytes. Auto-loaded from
     *   the package's bundled wasm if omitted.
     * @param {number}     [opts.replicaId=1]
     * @param {number}     [opts.capacity=1 << 20]  Max nodes the doc can hold.
     * @returns {Promise<RogueText>}
     */
    static create({ wasmBytes, replicaId, capacity }?: {
        wasmBytes?: Uint8Array<ArrayBufferLike> | undefined;
        replicaId?: number | undefined;
        capacity?: number | undefined;
    }): Promise<RogueText>;
    /**
     * @param {any} exp WASM exports (untyped numeric ABI).
     * @param {WebAssembly.Memory} mem
     */
    constructor(exp: any, mem: WebAssembly.Memory);
    _exp: any;
    _mem: WebAssembly.Memory;
    _inPtr: any;
    _outPtr: any;
    _length: number;
    /** Visible length in UTF-16 code units. */
    get length(): number;
    /** Insert `str` at visible index `idx`. @param {number} idx @param {string} str */
    insert(idx: number, str: string): void;
    /** Tombstone `len` code units starting at visible index `idx`. @param {number} idx @param {number} len */
    delete(idx: number, len: number): void;
    /** Materialize the current visible text. */
    toString(): string;
}
