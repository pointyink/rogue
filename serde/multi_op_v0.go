// multi_op_v0 — framing layer for an atomic batch of CRDT ops.
// See multi_op_v0.md. This codec emits/walks (disc, payload) tuples;
// parsing inner payloads is the caller's job.
package serde

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	MultiOpV0Disc     uint16 = 3
	MultiOpV0DiscSize        = 2
)

// MultiOpV0FixedOpSize returns (size, true) if `disc` names a fixed-shape
// op, else (0, false). Must agree with discriminators.md and peer
// implementations.
func MultiOpV0FixedOpSize(disc uint16) (uint32, bool) {
	switch disc {
	case 1, 2: // hide_v0 / show_v0 — id(6) + target(6) + len(4)
		return 16, true
	default:
		return 0, false
	}
}

type MultiOpV0InnerOp struct {
	Disc    uint16
	Payload []byte
}

type MultiOpV0 struct {
	GroupId NodeIdV0
	Ops     []MultiOpV0InnerOp
	Ca      []byte // trailing content-address bytes (nil if absent)
}

func multiOpV0FramedSize(op MultiOpV0InnerOp) int {
	if _, fixed := MultiOpV0FixedOpSize(op.Disc); fixed {
		return MultiOpV0DiscSize + len(op.Payload)
	}
	return MultiOpV0DiscSize + 4 + len(op.Payload)
}

// MultiOpV0EncodedSize returns the payload byte count (excluding the outer
// transport frame). caLen is the byte length of an optional trailing
// content-address blob (0 if absent).
func MultiOpV0EncodedSize(ops []MultiOpV0InnerOp, caLen int) int {
	n := 6 + 4 // group_id + op_count
	for _, op := range ops {
		n += multiOpV0FramedSize(op)
	}
	return n + caLen
}

// MultiOpV0Encode writes the multi_op payload to `out`. `out` must be
// MultiOpV0EncodedSize(ops, len(ca)) bytes long. `ca` is an optional
// trailing content-address blob (nil if absent). Returns bytes written.
func MultiOpV0Encode(groupId NodeIdV0, ops []MultiOpV0InnerOp, ca []byte, out []byte) int {
	off := 0
	NodeIdV0Encode(groupId, out, off)
	off += NodeIdV0Size

	binary.LittleEndian.PutUint32(out[off:off+4], uint32(len(ops)))
	off += 4

	for _, op := range ops {
		binary.LittleEndian.PutUint16(out[off:off+MultiOpV0DiscSize], op.Disc)
		off += MultiOpV0DiscSize
		if size, fixed := MultiOpV0FixedOpSize(op.Disc); fixed {
			if uint32(len(op.Payload)) != size {
				panic(fmt.Sprintf("multi_op_v0: disc=%d expected %d bytes, got %d", op.Disc, size, len(op.Payload)))
			}
			copy(out[off:off+len(op.Payload)], op.Payload)
			off += len(op.Payload)
		} else {
			binary.LittleEndian.PutUint32(out[off:off+4], uint32(len(op.Payload)))
			off += 4
			copy(out[off:off+len(op.Payload)], op.Payload)
			off += len(op.Payload)
		}
	}
	if len(ca) > 0 {
		copy(out[off:off+len(ca)], ca)
		off += len(ca)
	}
	return off
}

var (
	ErrMultiOpV0Truncated        = errors.New("multi_op_v0: truncated")
	ErrMultiOpV0UnknownInnerDisc = errors.New("multi_op_v0: unknown inner discriminator")
)

// MultiOpV0Decode parses a multi_op payload. Inner-op Payload slices alias
// `buf` — no copy, lifetime tied to `buf`.
func MultiOpV0Decode(buf []byte) (MultiOpV0, error) {
	if len(buf) < NodeIdV0Size+4 {
		return MultiOpV0{}, ErrMultiOpV0Truncated
	}
	off := 0
	groupId := NodeIdV0Decode(buf, off)
	off += NodeIdV0Size

	count := binary.LittleEndian.Uint32(buf[off : off+4])
	off += 4

	ops := make([]MultiOpV0InnerOp, count)
	for i := uint32(0); i < count; i++ {
		if off+MultiOpV0DiscSize > len(buf) {
			return MultiOpV0{}, ErrMultiOpV0Truncated
		}
		disc := binary.LittleEndian.Uint16(buf[off : off+MultiOpV0DiscSize])
		off += MultiOpV0DiscSize

		if size, fixed := MultiOpV0FixedOpSize(disc); fixed {
			if off+int(size) > len(buf) {
				return MultiOpV0{}, ErrMultiOpV0Truncated
			}
			ops[i] = MultiOpV0InnerOp{Disc: disc, Payload: buf[off : off+int(size)]}
			off += int(size)
		} else if disc == 0 {
			// insert_v0 — variable, length-prefixed
			if off+4 > len(buf) {
				return MultiOpV0{}, ErrMultiOpV0Truncated
			}
			length := binary.LittleEndian.Uint32(buf[off : off+4])
			off += 4
			if off+int(length) > len(buf) {
				return MultiOpV0{}, ErrMultiOpV0Truncated
			}
			ops[i] = MultiOpV0InnerOp{Disc: disc, Payload: buf[off : off+int(length)]}
			off += int(length)
		} else {
			return MultiOpV0{}, fmt.Errorf("%w: %d", ErrMultiOpV0UnknownInnerDisc, disc)
		}
	}
	var ca []byte
	if off < len(buf) {
		ca = buf[off:]
	}
	return MultiOpV0{GroupId: groupId, Ops: ops, Ca: ca}, nil
}
