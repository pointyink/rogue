// ack_v0 — variable-shape server → client durability ack. See ack_v0.md.
// Payload: count(4) + N × node_id_v0.
package serde

import (
	"encoding/binary"
	"errors"
)

const (
	AckV0Disc       uint16 = 4
	AckV0HeaderSize        = 4
)

type AckV0 struct {
	GroupIds []NodeIdV0
}

func AckV0EncodedSize(count int) int {
	return AckV0HeaderSize + NodeIdV0Size*count
}

// AckV0Encode writes an ack payload into `out`. `out` must be at least
// AckV0EncodedSize(len(groupIds)) bytes long. Returns bytes written.
func AckV0Encode(groupIds []NodeIdV0, out []byte) int {
	total := AckV0EncodedSize(len(groupIds))
	_ = out[total-1] // bounds check hoist

	binary.LittleEndian.PutUint32(out[0:4], uint32(len(groupIds)))
	off := AckV0HeaderSize
	for _, id := range groupIds {
		NodeIdV0Encode(id, out, off)
		off += NodeIdV0Size
	}
	return off
}

var ErrAckV0Truncated = errors.New("ack_v0: truncated")

// AckV0Decode parses an ack payload.
func AckV0Decode(buf []byte) (AckV0, error) {
	if len(buf) < AckV0HeaderSize {
		return AckV0{}, ErrAckV0Truncated
	}
	count := binary.LittleEndian.Uint32(buf[0:4])

	need := AckV0HeaderSize + NodeIdV0Size*int(count)
	if need > len(buf) {
		return AckV0{}, ErrAckV0Truncated
	}

	ids := make([]NodeIdV0, count)
	for i := range ids {
		ids[i] = NodeIdV0Decode(buf, AckV0HeaderSize+i*NodeIdV0Size)
	}
	return AckV0{GroupIds: ids}, nil
}
