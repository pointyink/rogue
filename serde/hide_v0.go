// hide_v0 — fixed-shape (16 byte) CRDT hide op. See hide_v0.md.
// Payload: id(6) + target(6) + len(4). Identical wire shape to show_v0;
// the discriminator carries the semantic difference.
package serde

import (
	"encoding/binary"
	"errors"
)

const (
	HideV0Disc uint16 = 1
	HideV0Size        = 16
)

type HideV0 struct {
	Id     NodeIdV0
	Target NodeIdV0
	Len    uint32
}

func HideV0Encode(h HideV0, out []byte) {
	_ = out[HideV0Size-1] // bounds check hoist
	NodeIdV0Encode(h.Id, out, 0)
	NodeIdV0Encode(h.Target, out, 6)
	binary.LittleEndian.PutUint32(out[12:16], h.Len)
}

var ErrHideV0Truncated = errors.New("hide_v0: truncated")

func HideV0Decode(buf []byte) (HideV0, error) {
	if len(buf) < HideV0Size {
		return HideV0{}, ErrHideV0Truncated
	}
	return HideV0{
		Id:     NodeIdV0Decode(buf, 0),
		Target: NodeIdV0Decode(buf, 6),
		Len:    binary.LittleEndian.Uint32(buf[12:16]),
	}, nil
}
