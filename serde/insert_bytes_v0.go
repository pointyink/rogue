// insert_bytes_v0 — variable-shape byte-native CRDT insert op.
// See insert_bytes_v0.md.
// Payload: id(6) + parent(6) + side(1) + byte_count(4) + bytes(N).
package serde

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const InsertBytesV0Disc uint16 = 6

type InsertBytesV0 struct {
	Id     NodeIdV0
	Parent NodeIdV0
	Side   InsertV0Side
	Bytes  []byte
}

const InsertBytesV0HeaderSize = 17 // id(6) + parent(6) + side(1) + byte_count(4)

func InsertBytesV0EncodedSize(byteCount int) int {
	return InsertBytesV0HeaderSize + byteCount
}

// InsertBytesV0Encode writes an insert payload into `out`. `out` must be at
// least InsertBytesV0EncodedSize(len(bytes)) bytes long. Returns bytes written.
func InsertBytesV0Encode(id, parent NodeIdV0, side InsertV0Side, bytes []byte, out []byte) int {
	total := InsertBytesV0EncodedSize(len(bytes))
	_ = out[total-1] // bounds check hoist

	off := 0
	NodeIdV0Encode(id, out, off)
	off += NodeIdV0Size
	NodeIdV0Encode(parent, out, off)
	off += NodeIdV0Size
	out[off] = uint8(side)
	off++
	binary.LittleEndian.PutUint32(out[off:off+4], uint32(len(bytes)))
	off += 4
	copy(out[off:off+len(bytes)], bytes)
	off += len(bytes)
	return off
}

var (
	ErrInsertBytesV0Truncated   = errors.New("insert_bytes_v0: truncated")
	ErrInsertBytesV0InvalidSide = errors.New("insert_bytes_v0: invalid side")
)

// InsertBytesV0Decode parses an insert payload. Allocates a new `Bytes` slice.
func InsertBytesV0Decode(buf []byte) (InsertBytesV0, error) {
	if len(buf) < InsertBytesV0HeaderSize {
		return InsertBytesV0{}, ErrInsertBytesV0Truncated
	}
	off := 0
	id := NodeIdV0Decode(buf, off)
	off += NodeIdV0Size
	parent := NodeIdV0Decode(buf, off)
	off += NodeIdV0Size

	sideRaw := buf[off]
	off++
	if sideRaw > 2 {
		return InsertBytesV0{}, fmt.Errorf("%w: %d", ErrInsertBytesV0InvalidSide, sideRaw)
	}

	byteCount := binary.LittleEndian.Uint32(buf[off : off+4])
	off += 4

	if off+int(byteCount) > len(buf) {
		return InsertBytesV0{}, ErrInsertBytesV0Truncated
	}

	bytes := make([]byte, byteCount)
	copy(bytes, buf[off:off+int(byteCount)])
	return InsertBytesV0{
		Id:     id,
		Parent: parent,
		Side:   InsertV0Side(sideRaw),
		Bytes:  bytes,
	}, nil
}
