// content_address_v0 — compact version vector codec.
//
// Wire format: count(u8) + count × (replica_id: u16 LE, sequence: u32 LE).
// An entry (r, s) means "all ops from replica r up to sequence s."
//
// Max 255 entries.
package serde

import "encoding/binary"

const CaV0EntrySize = 6

type CaV0Entry struct {
	ReplicaId uint16
	Sequence  uint32
}

func CaV0EncodedSize(entries []CaV0Entry) int {
	return 1 + len(entries)*CaV0EntrySize
}

func CaV0Encode(entries []CaV0Entry, out []byte) int {
	if len(entries) > 255 {
		panic("content_address_v0: too many entries")
	}
	out[0] = byte(len(entries))
	off := 1
	for _, e := range entries {
		binary.LittleEndian.PutUint16(out[off:off+2], e.ReplicaId)
		binary.LittleEndian.PutUint32(out[off+2:off+6], e.Sequence)
		off += CaV0EntrySize
	}
	return off
}

// CaV0Decode reads entries from `buf` into `out`. Returns the filled slice
// of `out` (never nil; empty slice if truncated or zero count).
func CaV0Decode(buf []byte, out []CaV0Entry) []CaV0Entry {
	if len(buf) < 1 {
		return out[:0]
	}
	count := int(buf[0])
	if len(buf) < 1+count*CaV0EntrySize || count == 0 {
		return out[:0]
	}
	off := 1
	for i := 0; i < count; i++ {
		out[i] = CaV0Entry{
			ReplicaId: binary.LittleEndian.Uint16(buf[off : off+2]),
			Sequence:  binary.LittleEndian.Uint32(buf[off+2 : off+6]),
		}
		off += CaV0EntrySize
	}
	return out[:count]
}
