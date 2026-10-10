// node_id_v0 — shared primitive codec. See node_id_v0.md for the spec.
//
// Embedded inside discriminated op types; never appears standalone on the
// wire. The struct is the wire-time shape; server code adapts to/from
// internal NodeId representations as needed.
package serde

import "encoding/binary"

const NodeIdV0Size = 6

type NodeIdV0 struct {
	ReplicaId uint16
	Sequence  uint32
}

// NodeIdV0Encode writes 6 little-endian bytes at buf[offset:offset+6]:
// u16 replica_id, then u32 sequence. Panics if buf is too short.
func NodeIdV0Encode(id NodeIdV0, buf []byte, offset int) {
	_ = buf[offset+NodeIdV0Size-1] // bounds check hoist
	binary.LittleEndian.PutUint16(buf[offset:offset+2], id.ReplicaId)
	binary.LittleEndian.PutUint32(buf[offset+2:offset+6], id.Sequence)
}

// NodeIdV0Decode reads 6 little-endian bytes from buf[offset:offset+6].
// Panics if buf is too short.
func NodeIdV0Decode(buf []byte, offset int) NodeIdV0 {
	_ = buf[offset+NodeIdV0Size-1] // bounds check hoist
	return NodeIdV0{
		ReplicaId: binary.LittleEndian.Uint16(buf[offset : offset+2]),
		Sequence:  binary.LittleEndian.Uint32(buf[offset+2 : offset+6]),
	}
}
