// insert_v0 — variable-shape CRDT insert op. See insert_v0.md.
// Payload: id(6) + parent(6) + side(1) + char_count(4) + chars(2*N).
package serde

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const InsertV0Disc uint16 = 0

type InsertV0Side uint8

const (
	InsertV0SideLeft  InsertV0Side = 0
	InsertV0SideRight InsertV0Side = 1
	InsertV0SideRoot  InsertV0Side = 2
)

func InsertV0SideFromString(s string) (InsertV0Side, error) {
	switch s {
	case "left":
		return InsertV0SideLeft, nil
	case "right":
		return InsertV0SideRight, nil
	case "root":
		return InsertV0SideRoot, nil
	}
	return 0, fmt.Errorf("insert_v0: unknown side %q", s)
}

func (s InsertV0Side) String() string {
	switch s {
	case InsertV0SideLeft:
		return "left"
	case InsertV0SideRight:
		return "right"
	case InsertV0SideRoot:
		return "root"
	}
	return fmt.Sprintf("invalid(%d)", uint8(s))
}

type InsertV0 struct {
	Id     NodeIdV0
	Parent NodeIdV0
	Side   InsertV0Side
	Chars  []uint16
}

const InsertV0HeaderSize = 17 // id(6) + parent(6) + side(1) + char_count(4)

func InsertV0EncodedSize(charCount int) int {
	return InsertV0HeaderSize + 2*charCount
}

// InsertV0Encode writes an insert payload into `out`. `out` must be at
// least InsertV0EncodedSize(len(chars)) bytes long. Returns bytes written.
func InsertV0Encode(id, parent NodeIdV0, side InsertV0Side, chars []uint16, out []byte) int {
	total := InsertV0EncodedSize(len(chars))
	_ = out[total-1] // bounds check hoist

	off := 0
	NodeIdV0Encode(id, out, off)
	off += NodeIdV0Size
	NodeIdV0Encode(parent, out, off)
	off += NodeIdV0Size
	out[off] = uint8(side)
	off++
	binary.LittleEndian.PutUint32(out[off:off+4], uint32(len(chars)))
	off += 4
	for _, c := range chars {
		binary.LittleEndian.PutUint16(out[off:off+2], c)
		off += 2
	}
	return off
}

var (
	ErrInsertV0Truncated   = errors.New("insert_v0: truncated")
	ErrInsertV0InvalidSide = errors.New("insert_v0: invalid side")
)

// InsertV0Decode parses an insert payload. Allocates a new `Chars` slice.
func InsertV0Decode(buf []byte) (InsertV0, error) {
	if len(buf) < InsertV0HeaderSize {
		return InsertV0{}, ErrInsertV0Truncated
	}
	off := 0
	id := NodeIdV0Decode(buf, off)
	off += NodeIdV0Size
	parent := NodeIdV0Decode(buf, off)
	off += NodeIdV0Size

	sideRaw := buf[off]
	off++
	if sideRaw > 2 {
		return InsertV0{}, fmt.Errorf("%w: %d", ErrInsertV0InvalidSide, sideRaw)
	}
	side := InsertV0Side(sideRaw)

	charCount := binary.LittleEndian.Uint32(buf[off : off+4])
	off += 4

	needBytes := 2 * int(charCount)
	if off+needBytes > len(buf) {
		return InsertV0{}, ErrInsertV0Truncated
	}

	chars := make([]uint16, charCount)
	for i := range chars {
		chars[i] = binary.LittleEndian.Uint16(buf[off+2*i : off+2*i+2])
	}
	return InsertV0{Id: id, Parent: parent, Side: side, Chars: chars}, nil
}
