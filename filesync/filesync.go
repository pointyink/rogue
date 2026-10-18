// Package filesync is a byte-native CRDT document for file sync.
//
// It embeds the rogue_u8.wasm build of the Rogue engine (Rogue(u8) +
// insert_bytes_v0) and runs it with wazero. The API is intentionally small:
// insert/hide/replace local bytes, apply remote multi_op frames, and render
// the visible bytes. All wire encoding/decoding happens inside the wasm; the
// host passes opaque multi_op bytes.
package filesync

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

//go:embed rogue_u8.wasm
var wasmBytes []byte

// Version identifies the wire shape this package speaks.
const Version = "insert_bytes_v0/1"

// ErrParked means a remote op arrived before its parent/target; the caller
// should retry after applying the missing dependency.
var ErrParked = errors.New("filesync: op parked (missing dependency)")

// Doc is a single-replica byte-native CRDT document. It is safe for
// concurrent use, but batching (BeginBatch/CommitBatch) is not reentrant.
type Doc struct {
	mu  sync.Mutex
	ctx context.Context
	rt  wazero.Runtime
	mod api.Module
	mem api.Memory

	inPtr, outPtr uint32
	inCap, outCap uint32

	fnInPtr, fnOutPtr, fnOutLen, fnInCap, fnOutCap api.Function
	fnInit, fnDeinit, fnBeginBatch, fnCommitBatch  api.Function
	fnInsert, fnHide, fnReplace, fnMerge, fnRender api.Function
	fnVisLen                                       api.Function
}

// New creates a byte-native document for the given replica id.
func New(replicaID uint16) (*Doc, error) {
	ctx := context.Background()
	rt := wazero.NewRuntime(ctx)
	mod, err := rt.InstantiateWithConfig(ctx, wasmBytes, wazero.NewModuleConfig().WithName("rogue_u8"))
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("filesync: instantiate: %w", err)
	}
	mem := mod.ExportedMemory("memory")
	if mem == nil {
		_ = rt.Close(ctx)
		return nil, errors.New("filesync: wasm has no memory export")
	}

	d := &Doc{ctx: ctx, rt: rt, mod: mod, mem: mem}
	d.fnInPtr = mod.ExportedFunction("rogue_u8_in_ptr")
	d.fnOutPtr = mod.ExportedFunction("rogue_u8_out_ptr")
	d.fnOutLen = mod.ExportedFunction("rogue_u8_out_len")
	d.fnInCap = mod.ExportedFunction("rogue_u8_in_cap")
	d.fnOutCap = mod.ExportedFunction("rogue_u8_out_cap")
	d.fnInit = mod.ExportedFunction("rogue_u8_init")
	d.fnDeinit = mod.ExportedFunction("rogue_u8_deinit")
	d.fnBeginBatch = mod.ExportedFunction("rogue_u8_begin_batch")
	d.fnCommitBatch = mod.ExportedFunction("rogue_u8_commit_batch")
	d.fnInsert = mod.ExportedFunction("rogue_u8_insert")
	d.fnHide = mod.ExportedFunction("rogue_u8_hide")
	d.fnReplace = mod.ExportedFunction("rogue_u8_replace")
	d.fnMerge = mod.ExportedFunction("rogue_u8_merge")
	d.fnRender = mod.ExportedFunction("rogue_u8_render")
	d.fnVisLen = mod.ExportedFunction("rogue_u8_vis_len")

	if d.fnInPtr == nil || d.fnOutPtr == nil || d.fnOutLen == nil ||
		d.fnInCap == nil || d.fnOutCap == nil || d.fnInit == nil ||
		d.fnBeginBatch == nil || d.fnCommitBatch == nil || d.fnInsert == nil ||
		d.fnHide == nil || d.fnReplace == nil || d.fnMerge == nil ||
		d.fnRender == nil || d.fnVisLen == nil {
		_ = rt.Close(ctx)
		return nil, errors.New("filesync: wasm is missing expected exports")
	}

	d.inPtr, err = d.callU32(d.fnInPtr)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("filesync: in_ptr: %w", err)
	}
	d.outPtr, err = d.callU32(d.fnOutPtr)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("filesync: out_ptr: %w", err)
	}
	d.inCap, err = d.callU32(d.fnInCap)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("filesync: in_cap: %w", err)
	}
	d.outCap, err = d.callU32(d.fnOutCap)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("filesync: out_cap: %w", err)
	}

	ret, err := d.call(d.fnInit, uint64(replicaID), 1024)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("filesync: init: %w", err)
	}
	if ret != 1 {
		err := d.lastError("init")
		_ = rt.Close(ctx)
		return nil, err
	}
	return d, nil
}

// Version reports the wire shape this document speaks.
func (d *Doc) WireVersion() string { return Version }

// Len returns the number of visible bytes.
func (d *Doc) Len() (uint32, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.callU32(d.fnVisLen)
}

// Bytes renders the visible document as raw bytes.
func (d *Doc) Bytes() ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	ret, err := d.call(d.fnRender)
	if err != nil {
		return nil, fmt.Errorf("filesync: render: %w", err)
	}
	if ret != 1 {
		return nil, d.lastError("render")
	}
	return d.readOut()
}

// Insert writes data at visible byte index visIx. It returns the serialized
// multi_op to broadcast (nil if data is empty). In batch mode it returns nil;
// the ops commit with CommitBatch.
func (d *Doc) Insert(visIx uint32, data []byte) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.writeInput(data); err != nil {
		return nil, fmt.Errorf("filesync: insert: %w", err)
	}
	ret, err := d.call(d.fnInsert, uint64(visIx), 0, uint64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("filesync: insert: %w", err)
	}
	if ret != 1 {
		return nil, d.lastError("insert")
	}
	return d.readOut()
}

// Hide removes length visible bytes starting at visIx. It returns the
// serialized multi_op to broadcast (nil if length is zero or while batching).
func (d *Doc) Hide(visIx, length uint32) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	ret, err := d.call(d.fnHide, uint64(visIx), uint64(length))
	if err != nil {
		return nil, fmt.Errorf("filesync: hide: %w", err)
	}
	if ret != 1 {
		return nil, d.lastError("hide")
	}
	return d.readOut()
}

// Replace atomically replaces deleteLen visible bytes at visIx with data,
// emitting a single multi_op. Returns nil if both deleteLen and data are empty,
// or while batching (the ops commit with CommitBatch).
func (d *Doc) Replace(visIx, deleteLen uint32, data []byte) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.writeInput(data); err != nil {
		return nil, fmt.Errorf("filesync: replace: %w", err)
	}
	ret, err := d.call(d.fnReplace, uint64(visIx), uint64(deleteLen), 0, uint64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("filesync: replace: %w", err)
	}
	if ret == 0 {
		return nil, nil
	}
	if ret != 1 {
		return nil, d.lastError("replace")
	}
	return d.readOut()
}

// Apply merges a serialized multi_op from a peer. ErrParked means a dependency
// has not arrived yet; retry after applying it.
func (d *Doc) Apply(op []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.writeInput(op); err != nil {
		return fmt.Errorf("filesync: apply: %w", err)
	}
	ret, err := d.call(d.fnMerge, uint64(len(op)))
	if err != nil {
		return fmt.Errorf("filesync: apply: %w", err)
	}
	switch ret {
	case 1:
		return nil
	case 0:
		return ErrParked
	default:
		return d.lastError("apply")
	}
}

// BeginBatch starts collecting local ops into one multi_op. Call CommitBatch
// to merge and serialize them; Insert/Hide/Replace return nil until then.
// Positions are stamped against the pre-batch document, so a batch cannot see
// its own earlier unmerged inserts.
func (d *Doc) BeginBatch() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.call(d.fnBeginBatch)
	return err
}

// CommitBatch merges and serializes the batch. nil means the batch was empty.
func (d *Doc) CommitBatch() ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	ret, err := d.call(d.fnCommitBatch)
	if err != nil {
		return nil, fmt.Errorf("filesync: commit: %w", err)
	}
	if ret == 0 {
		return nil, nil
	}
	if ret != 1 {
		return nil, d.lastError("commit")
	}
	return d.readOut()
}

// Close releases the wasm runtime.
func (d *Doc) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.rt == nil {
		return nil
	}
	err := d.rt.Close(d.ctx)
	d.rt = nil
	d.mod = nil
	d.mem = nil
	return err
}

func (d *Doc) call(fn api.Function, params ...uint64) (uint32, error) {
	res, err := fn.Call(d.ctx, params...)
	if err != nil {
		return 0, err
	}
	if len(res) == 0 {
		return 0, nil
	}
	return uint32(res[0]), nil
}

func (d *Doc) callU32(fn api.Function) (uint32, error) {
	return d.call(fn)
}

func (d *Doc) writeInput(data []byte) error {
	if uint32(len(data)) > d.inCap {
		return fmt.Errorf("%d bytes exceeds input buffer %d", len(data), d.inCap)
	}
	if len(data) == 0 {
		return nil
	}
	if !d.mem.Write(d.inPtr, data) {
		return errors.New("write to wasm memory failed")
	}
	return nil
}

func (d *Doc) readOut() ([]byte, error) {
	n, err := d.callU32(d.fnOutLen)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, nil
	}
	if n > d.outCap {
		return nil, fmt.Errorf("out_len %d exceeds output buffer %d", n, d.outCap)
	}
	b, ok := d.mem.Read(d.outPtr, n)
	if !ok {
		return nil, errors.New("read from wasm memory failed")
	}
	out := make([]byte, n)
	copy(out, b)
	return out, nil
}

func (d *Doc) lastError(prefix string) error {
	n, err := d.callU32(d.fnOutLen)
	if err != nil {
		return fmt.Errorf("filesync: %s (and out_len failed: %v)", prefix, err)
	}
	if n == 0 {
		return fmt.Errorf("filesync: %s", prefix)
	}
	b, ok := d.mem.Read(d.outPtr, n)
	if !ok {
		return fmt.Errorf("filesync: %s (unreadable error)", prefix)
	}
	return fmt.Errorf("filesync: %s: %s", prefix, string(b))
}
