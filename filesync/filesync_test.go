package filesync

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/pointyink/rogue/serde"
)

func newDoc(t *testing.T, replica uint16) *Doc {
	t.Helper()
	d, err := New(replica)
	if err != nil {
		t.Fatalf("New(%d): %v", replica, err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

func wantBytes(t *testing.T, d *Doc, want []byte) {
	t.Helper()
	got, err := d.Bytes()
	if err != nil {
		t.Fatalf("Bytes: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("Bytes = %q, want %q", got, want)
	}
	n, err := d.Len()
	if err != nil {
		t.Fatalf("Len: %v", err)
	}
	if n != uint32(len(want)) {
		t.Fatalf("Len = %d, want %d", n, len(want))
	}
}

func TestEmpty(t *testing.T) {
	d := newDoc(t, 1)
	wantBytes(t, d, nil)
}

func TestRoundTrip(t *testing.T) {
	d := newDoc(t, 1)
	op, err := d.Insert(0, []byte("hello"))
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if len(op) == 0 {
		t.Fatal("Insert returned an empty op")
	}
	wantBytes(t, d, []byte("hello"))
}

func TestInsertAtStartAndEnd(t *testing.T) {
	d := newDoc(t, 1)
	if _, err := d.Insert(0, []byte("world")); err != nil {
		t.Fatalf("Insert world: %v", err)
	}
	if _, err := d.Insert(0, []byte("hello ")); err != nil {
		t.Fatalf("Insert hello: %v", err)
	}
	wantBytes(t, d, []byte("hello world"))
	if _, err := d.Insert(11, []byte("!")); err != nil {
		t.Fatalf("Insert !: %v", err)
	}
	wantBytes(t, d, []byte("hello world!"))
}

func TestBinary(t *testing.T) {
	all := make([]byte, 256)
	for i := range all {
		all[i] = byte(i)
	}
	d := newDoc(t, 7)
	if _, err := d.Insert(0, all); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	wantBytes(t, d, all)
}

func TestMerge(t *testing.T) {
	a := newDoc(t, 1)
	b := newDoc(t, 2)

	opA, err := a.Insert(0, []byte("hello"))
	if err != nil {
		t.Fatalf("A insert: %v", err)
	}
	if err := b.Apply(opA); err != nil {
		t.Fatalf("B apply: %v", err)
	}
	wantBytes(t, b, []byte("hello"))

	opB, err := b.Insert(5, []byte(" world"))
	if err != nil {
		t.Fatalf("B insert: %v", err)
	}
	if err := a.Apply(opB); err != nil {
		t.Fatalf("A apply: %v", err)
	}
	wantBytes(t, a, []byte("hello world"))
	wantBytes(t, b, []byte("hello world"))

	// Idempotent: applying the same op twice must not duplicate content.
	if err := a.Apply(opB); err != nil {
		t.Fatalf("A re-apply: %v", err)
	}
	wantBytes(t, a, []byte("hello world"))
}

func TestReplace(t *testing.T) {
	d := newDoc(t, 3)
	if _, err := d.Insert(0, []byte("hello")); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	op, err := d.Replace(0, 5, []byte("goodbye"))
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if len(op) == 0 {
		t.Fatal("Replace returned an empty op")
	}
	wantBytes(t, d, []byte("goodbye"))
}

func TestReplaceNoop(t *testing.T) {
	d := newDoc(t, 3)
	if _, err := d.Insert(0, []byte("hello")); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	op, err := d.Replace(0, 0, nil)
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if op != nil {
		t.Fatalf("Replace no-op returned %d bytes", len(op))
	}
	wantBytes(t, d, []byte("hello"))
}

func TestEmptyInsert(t *testing.T) {
	d := newDoc(t, 1)
	op, err := d.Insert(0, nil)
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if op != nil {
		t.Fatalf("empty insert returned %d bytes", len(op))
	}
	wantBytes(t, d, nil)
}

func TestHide(t *testing.T) {
	d := newDoc(t, 1)
	if _, err := d.Insert(0, []byte("hello")); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	op, err := d.Hide(1, 3)
	if err != nil {
		t.Fatalf("Hide: %v", err)
	}
	if len(op) == 0 {
		t.Fatal("Hide returned an empty op")
	}
	wantBytes(t, d, []byte("ho"))
}

func TestReplaceAtEnd(t *testing.T) {
	d := newDoc(t, 1)
	if _, err := d.Insert(0, []byte("hello")); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	op, err := d.Replace(5, 0, []byte(" world"))
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if len(op) == 0 {
		t.Fatal("Replace at end returned an empty op")
	}
	wantBytes(t, d, []byte("hello world"))
}

func TestReplaceBatch(t *testing.T) {
	d := newDoc(t, 1)
	if _, err := d.Insert(0, []byte("hello")); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if err := d.BeginBatch(); err != nil {
		t.Fatalf("BeginBatch: %v", err)
	}
	op, err := d.Replace(0, 5, []byte("goodbye"))
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if op != nil {
		t.Fatalf("Replace in batch returned %d bytes", len(op))
	}
	op, err = d.CommitBatch()
	if err != nil {
		t.Fatalf("CommitBatch: %v", err)
	}
	if len(op) == 0 {
		t.Fatal("CommitBatch returned an empty op")
	}
	wantBytes(t, d, []byte("goodbye"))
}

func TestBatchReturnsNil(t *testing.T) {
	d := newDoc(t, 1)
	if err := d.BeginBatch(); err != nil {
		t.Fatalf("BeginBatch: %v", err)
	}
	op, err := d.Insert(0, []byte("hello"))
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if op != nil {
		t.Fatalf("Insert in batch returned %d bytes", len(op))
	}
	op, err = d.CommitBatch()
	if err != nil {
		t.Fatalf("CommitBatch: %v", err)
	}
	if len(op) == 0 {
		t.Fatal("CommitBatch returned an empty op")
	}
	wantBytes(t, d, []byte("hello"))
}

func TestOversizedInsert(t *testing.T) {
	d := newDoc(t, 1)
	data := make([]byte, (8<<20)+1)
	if _, err := d.Insert(0, data); err == nil {
		t.Fatal("expected an input-buffer error")
	}
}

func TestCrossKindReject(t *testing.T) {
	d := newDoc(t, 1)

	// A valid u16 insert_v0 batch must be a permanent rejection in the u8 engine.
	payload := make([]byte, serde.InsertV0EncodedSize(2))
	serde.InsertV0Encode(
		serde.NodeIdV0{ReplicaId: 9, Sequence: 1},
		serde.NodeIdV0{},
		serde.InsertV0SideRoot,
		[]uint16{'h', 'i'},
		payload,
	)
	ops := []serde.MultiOpV0InnerOp{{Disc: serde.InsertV0Disc, Payload: payload}}
	frame := make([]byte, serde.MultiOpV0EncodedSize(ops, 0))
	serde.MultiOpV0Encode(serde.NodeIdV0{ReplicaId: 9, Sequence: 1}, ops, nil, frame)

	err := d.Apply(frame)
	if err == nil {
		t.Fatal("expected the u8 engine to reject insert_v0")
	}
	if errors.Is(err, ErrParked) {
		t.Fatalf("wrong-kind op must be permanent, got ErrParked")
	}
	if !strings.Contains(err.Error(), "UnknownInnerDisc") {
		t.Fatalf("got %v, want UnknownInnerDisc", err)
	}
	wantBytes(t, d, nil)
}

func TestBatch(t *testing.T) {
	d := newDoc(t, 4)
	if err := d.BeginBatch(); err != nil {
		t.Fatalf("BeginBatch: %v", err)
	}
	// Batch ops are stamped against the pre-batch document; positions don't
	// see earlier unmerged ops. A single insert (or Replace) is the common use.
	if _, err := d.Insert(0, []byte("hello world")); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	op, err := d.CommitBatch()
	if err != nil {
		t.Fatalf("CommitBatch: %v", err)
	}
	if len(op) == 0 {
		t.Fatal("CommitBatch returned an empty op")
	}
	wantBytes(t, d, []byte("hello world"))

	peer := newDoc(t, 5)
	if err := peer.Apply(op); err != nil {
		t.Fatalf("peer apply: %v", err)
	}
	wantBytes(t, peer, []byte("hello world"))
}
