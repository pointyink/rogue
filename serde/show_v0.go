// show_v0 — fixed-shape (16 byte) CRDT show op. See show_v0.md.
// Same wire shape as hide_v0; the discriminator carries the difference.
package serde

import (
	"encoding/binary"
	"errors"
)

const (
	ShowV0Disc uint16 = 2
	ShowV0Size        = 16
)

type ShowV0 struct {
	Id     NodeIdV0
	Target NodeIdV0
	Len    uint32
}

func ShowV0Encode(s ShowV0, out []byte) {
	_ = out[ShowV0Size-1]
	NodeIdV0Encode(s.Id, out, 0)
	NodeIdV0Encode(s.Target, out, 6)
	binary.LittleEndian.PutUint32(out[12:16], s.Len)
}

var ErrShowV0Truncated = errors.New("show_v0: truncated")

func ShowV0Decode(buf []byte) (ShowV0, error) {
	if len(buf) < ShowV0Size {
		return ShowV0{}, ErrShowV0Truncated
	}
	return ShowV0{
		Id:     NodeIdV0Decode(buf, 0),
		Target: NodeIdV0Decode(buf, 6),
		Len:    binary.LittleEndian.Uint32(buf[12:16]),
	}, nil
}
