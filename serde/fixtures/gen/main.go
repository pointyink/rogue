// Gen script for serde fixtures. Hand-written cases drive a single Go
// encoder; the bytes that fall out are the canonical wire shape for that
// case. Each fixture lands as a directory of two or three files:
//
//	positive/<type>/<name>/bytes.bin     canonical encoded bytes
//	positive/<type>/<name>/value.json    canonical decoded structure
//
//	negative/<type>/<name>/bytes.bin     corrupted / invalid bytes
//	negative/<type>/<name>/error.txt     expected error kind
//
// The bytes.bin file is the source of truth — every language must decode
// it to the value in value.json and encode that value back to the exact
// same bytes. Hand-verify a few new fixtures by eye-balling the hex after
// generation; from that point on the bytes are the spec.
//
// Run:  go run ./serde/fixtures/gen   (from the repo root)
//
// Re-run any time you add cases. The data subdirs (positive/, negative/)
// are wiped clean on each run so renamed/removed fixtures don't leave
// stale files behind. This source tree (serde/fixtures/gen/) is preserved.
package main

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/pointyink/rogue/serde"
)

const outRoot = "serde/fixtures"

func main() {
	// Wipe data subdirs only — preserve this gen source tree.
	for _, sub := range []string{"positive", "negative"} {
		p := filepath.Join(outRoot, sub)
		if err := os.RemoveAll(p); err != nil {
			fail("clean %s: %v", p, err)
		}
	}

	writeNodeIdV0Positive()
	writeMultiOpV0Positive()
	writeMultiOpV0Negative()
	writeInsertV0Positive()
	writeInsertV0Negative()
	writeInsertBytesV0Positive()
	writeInsertBytesV0Negative()
	writeHideV0Positive()
	writeHideV0Negative()
	writeShowV0Positive()
	writeShowV0Negative()
	writeAckV0Positive()
	writeAckV0Negative()
	writeJsonEnvelopeV0Positive()

	fmt.Println("ok")
}

// ---- json_envelope_v0 ----
//
// The codec is identity, so fixtures here exist mostly to lock the wire
// shape ("payload is just the bytes, no header") and to ensure all three
// languages agree they're pass-through.

type jsonEnvelopeValue struct {
	Type       string `json:"type"`
	PayloadHex string `json:"payload_hex"`
}

func writeJsonEnvelopeV0Positive() {
	cases := []struct {
		name string
		json string
	}{
		{"empty_object", `{}`},
		{"empty_payload", ``},
		{"cursor", `{"type":"cursor","user_id":"abc","line":10,"col":20}`},
		{"comment", `{"type":"comment","id":"x","text":"hello"}`},
		{"typing_ping", `{"type":"typing","user_id":"abc"}`},
		{"unicode_text", `{"type":"comment","text":"héllo 👋 wörld"}`},
		{"deep_nesting", `{"type":"x","data":{"a":{"b":{"c":[1,2,3]}}}}`},
		{"large_payload", `{"type":"bulk","items":` + buildLargeArray(100) + `}`},
	}

	for _, c := range cases {
		payload := []byte(c.json)
		writePositive("json_envelope_v0", c.name, payload, jsonEnvelopeValue{
			Type:       "json_envelope_v0",
			PayloadHex: hex.EncodeToString(payload),
		})
	}
}

func buildLargeArray(n int) string {
	out := "["
	for i := 0; i < n; i++ {
		if i > 0 {
			out += ","
		}
		out += fmt.Sprintf(`{"i":%d,"label":"item_%d"}`, i, i)
	}
	out += "]"
	return out
}

// ---- ack_v0 ----

type ackValue struct {
	Type     string       `json:"type"`
	GroupIds []nodeIdJSON `json:"group_ids"`
}

func writeAckV0Positive() {
	mid := []serde.NodeIdV0{
		{ReplicaId: 1, Sequence: 10},
		{ReplicaId: 1, Sequence: 11},
		{ReplicaId: 2, Sequence: 5},
		{ReplicaId: 7, Sequence: 42},
		{ReplicaId: 9, Sequence: 100},
	}
	large := make([]serde.NodeIdV0, 1000)
	for i := range large {
		large[i] = serde.NodeIdV0{ReplicaId: uint16(i % 7), Sequence: uint32(i)}
	}

	cases := []struct {
		name string
		ids  []serde.NodeIdV0
	}{
		{"empty", []serde.NodeIdV0{}},
		{"single", []serde.NodeIdV0{{ReplicaId: 7, Sequence: 42}}},
		{"five_ids", mid},
		{"thousand_ids", large},
		{"endian_probe", []serde.NodeIdV0{
			{ReplicaId: 0x0201, Sequence: 0x06050403},
			{ReplicaId: 0x0807, Sequence: 0x0C0B0A09},
		}},
	}

	for _, c := range cases {
		buf := make([]byte, serde.AckV0EncodedSize(len(c.ids)))
		serde.AckV0Encode(c.ids, buf)

		idsJSON := make([]nodeIdJSON, len(c.ids))
		for i, id := range c.ids {
			idsJSON[i] = nodeIdJSON{ReplicaId: id.ReplicaId, Sequence: id.Sequence}
		}
		writePositive("ack_v0", c.name, buf, ackValue{
			Type:     "ack_v0",
			GroupIds: idsJSON,
		})
	}
}

func writeAckV0Negative() {
	negative := []fixedOpNegCase{
		{
			"truncated_header_empty",
			[]byte{},
			"truncated_header",
		},
		{
			"truncated_header_partial",
			[]byte{1, 2},
			"truncated_header",
		},
		{
			"truncated_ids",
			func() []byte {
				// count=2 but only 1 id of bytes follow
				b := make([]byte, 4+6)
				binary.LittleEndian.PutUint32(b[0:4], 2)
				return b
			}(),
			"truncated_ids",
		},
		{
			"count_overflow",
			func() []byte {
				// count=u32_max with no ids — must reject before allocating
				b := make([]byte, 4)
				binary.LittleEndian.PutUint32(b[0:4], 0xFFFFFFFF)
				return b
			}(),
			"truncated_ids",
		},
	}

	for _, c := range negative {
		writeNegative("ack_v0", c.name, c.bytes, c.errorKind)
	}
}

// ---- hide_v0 / show_v0 ----
//
// Identical wire shape, identical fixture coverage. Two parallel sets so each
// language's runner exercises both discriminators.

type hideShowValue struct {
	Type   string     `json:"type"`
	Id     nodeIdJSON `json:"id"`
	Target nodeIdJSON `json:"target"`
	Len    uint32     `json:"len"`
}

type hideShowCase struct {
	name   string
	id     serde.NodeIdV0
	target serde.NodeIdV0
	length uint32
}

func hideShowCases() []hideShowCase {
	return []hideShowCase{
		{"zero", serde.NodeIdV0{}, serde.NodeIdV0{}, 0},
		{"len_one", serde.NodeIdV0{ReplicaId: 1, Sequence: 10}, serde.NodeIdV0{ReplicaId: 1, Sequence: 5}, 1},
		{"len_small", serde.NodeIdV0{ReplicaId: 2, Sequence: 100}, serde.NodeIdV0{ReplicaId: 3, Sequence: 42}, 5},
		{"len_large", serde.NodeIdV0{ReplicaId: 9, Sequence: 1}, serde.NodeIdV0{ReplicaId: 9, Sequence: 100}, 1000},
		{"len_max", serde.NodeIdV0{ReplicaId: 0xFFFF, Sequence: 0xFFFFFFFF}, serde.NodeIdV0{ReplicaId: 0xFFFE, Sequence: 0xFFFFFFFE}, 0xFFFFFFFF},
		{"endian_probe", serde.NodeIdV0{ReplicaId: 0x0201, Sequence: 0x06050403}, serde.NodeIdV0{ReplicaId: 0x0807, Sequence: 0x0C0B0A09}, 0x100D0E0F},
	}
}

func writeHideV0Positive() {
	for _, c := range hideShowCases() {
		buf := make([]byte, serde.HideV0Size)
		serde.HideV0Encode(serde.HideV0{Id: c.id, Target: c.target, Len: c.length}, buf)
		writePositive("hide_v0", c.name, buf, hideShowValue{
			Type:   "hide_v0",
			Id:     nodeIdJSON{ReplicaId: c.id.ReplicaId, Sequence: c.id.Sequence},
			Target: nodeIdJSON{ReplicaId: c.target.ReplicaId, Sequence: c.target.Sequence},
			Len:    c.length,
		})
	}
}

func writeShowV0Positive() {
	for _, c := range hideShowCases() {
		buf := make([]byte, serde.ShowV0Size)
		serde.ShowV0Encode(serde.ShowV0{Id: c.id, Target: c.target, Len: c.length}, buf)
		writePositive("show_v0", c.name, buf, hideShowValue{
			Type:   "show_v0",
			Id:     nodeIdJSON{ReplicaId: c.id.ReplicaId, Sequence: c.id.Sequence},
			Target: nodeIdJSON{ReplicaId: c.target.ReplicaId, Sequence: c.target.Sequence},
			Len:    c.length,
		})
	}
}

func writeHideV0Negative() {
	for _, c := range hideShowNegative() {
		writeNegative("hide_v0", c.name, c.bytes, c.errorKind)
	}
}

func writeShowV0Negative() {
	for _, c := range hideShowNegative() {
		writeNegative("show_v0", c.name, c.bytes, c.errorKind)
	}
}

type fixedOpNegCase struct {
	name      string
	bytes     []byte
	errorKind string
}

func hideShowNegative() []fixedOpNegCase {
	return []fixedOpNegCase{
		{"truncated_header_empty", []byte{}, "truncated_header"},
		{"truncated_header_partial", make([]byte, 10), "truncated_header"}, // 10 < 16
		{"truncated_one_byte_short", make([]byte, 15), "truncated_header"}, // boundary
	}
}

// ---- insert_v0 ----

type insertValue struct {
	Type     string     `json:"type"`
	Id       nodeIdJSON `json:"id"`
	Parent   nodeIdJSON `json:"parent"`
	Side     string     `json:"side"`
	CharsHex string     `json:"chars_hex"`
}

// charsToHex converts a u16 slice to the LE byte hex string used in fixtures.
func charsToHex(chars []uint16) string {
	b := make([]byte, 2*len(chars))
	for i, c := range chars {
		binary.LittleEndian.PutUint16(b[2*i:2*i+2], c)
	}
	return hex.EncodeToString(b)
}

func writeInsertV0Positive() {
	helloWorld := []uint16{'H', 'e', 'l', 'l', 'o', ',', ' ', 'w', 'o', 'r', 'l', 'd', '!'}
	emojiSmile := []uint16{0xD83D, 0xDE00}                                              // U+1F600
	mixedEmoji := []uint16{'H', 'i', ' ', 0xD83D, 0xDC4B, ' ', 'W', 'o', 'r', 'l', 'd'} // "Hi 👋 World"
	// Large: 1000 'x'
	large := make([]uint16, 1000)
	for i := range large {
		large[i] = 'x'
	}

	cases := []struct {
		name   string
		id     serde.NodeIdV0
		parent serde.NodeIdV0
		side   serde.InsertV0Side
		chars  []uint16
	}{
		{
			"empty_chars_left",
			serde.NodeIdV0{ReplicaId: 1, Sequence: 10},
			serde.NodeIdV0{ReplicaId: 1, Sequence: 9},
			serde.InsertV0SideLeft,
			[]uint16{},
		},
		{
			"ascii_hi_right",
			serde.NodeIdV0{ReplicaId: 7, Sequence: 100},
			serde.NodeIdV0{ReplicaId: 7, Sequence: 99},
			serde.InsertV0SideRight,
			[]uint16{'H', 'i'},
		},
		{
			"ascii_hello_world_right",
			serde.NodeIdV0{ReplicaId: 2, Sequence: 50},
			serde.NodeIdV0{ReplicaId: 2, Sequence: 49},
			serde.InsertV0SideRight,
			helloWorld,
		},
		{
			"root_insert",
			serde.NodeIdV0{ReplicaId: 1, Sequence: 1},
			serde.NodeIdV0{ReplicaId: 0, Sequence: 0}, // NULL — convention for Root
			serde.InsertV0SideRoot,
			[]uint16{'A'},
		},
		{
			"emoji_smile_right",
			serde.NodeIdV0{ReplicaId: 5, Sequence: 200},
			serde.NodeIdV0{ReplicaId: 5, Sequence: 199},
			serde.InsertV0SideRight,
			emojiSmile,
		},
		{
			"mixed_text_emoji_right",
			serde.NodeIdV0{ReplicaId: 5, Sequence: 300},
			serde.NodeIdV0{ReplicaId: 5, Sequence: 299},
			serde.InsertV0SideRight,
			mixedEmoji,
		},
		{
			"large_chars_right",
			serde.NodeIdV0{ReplicaId: 9, Sequence: 1},
			serde.NodeIdV0{ReplicaId: 9, Sequence: 0},
			serde.InsertV0SideRight,
			large,
		},
		{
			"endian_probe",
			serde.NodeIdV0{ReplicaId: 0x0201, Sequence: 0x06050403},
			serde.NodeIdV0{ReplicaId: 0x0A09, Sequence: 0x0E0D0C0B},
			serde.InsertV0SideRight,
			// 0x0201 → 01 02, 0x0403 → 03 04. Chars hex: "01020304".
			[]uint16{0x0201, 0x0403},
		},
	}

	for _, c := range cases {
		buf := make([]byte, serde.InsertV0EncodedSize(len(c.chars)))
		serde.InsertV0Encode(c.id, c.parent, c.side, c.chars, buf)

		writePositive("insert_v0", c.name, buf, insertValue{
			Type:     "insert_v0",
			Id:       nodeIdJSON{ReplicaId: c.id.ReplicaId, Sequence: c.id.Sequence},
			Parent:   nodeIdJSON{ReplicaId: c.parent.ReplicaId, Sequence: c.parent.Sequence},
			Side:     c.side.String(),
			CharsHex: charsToHex(c.chars),
		})
	}
}

// ---- insert_v0 negative ----
//
// Error kinds:
//   truncated_header        bytes shorter than 17
//   truncated_chars         char_count declared more chars than remain
//   invalid_side            side byte not in {0, 1, 2}

func writeInsertV0Negative() {
	negative := []struct {
		name      string
		bytes     []byte
		errorKind string
	}{
		{
			"truncated_header_empty",
			[]byte{},
			"truncated_header",
		},
		{
			"truncated_header_partial",
			make([]byte, 10), // 10 < 17
			"truncated_header",
		},
		{
			"invalid_side_byte",
			func() []byte {
				b := make([]byte, 17)
				b[12] = 99 // invalid side
				return b
			}(),
			"invalid_side",
		},
		{
			"invalid_side_high",
			func() []byte {
				b := make([]byte, 17)
				b[12] = 0xFF
				return b
			}(),
			"invalid_side",
		},
		{
			"truncated_chars_short",
			func() []byte {
				// header says char_count=5 (10 bytes of chars), but only 2 bytes follow
				b := make([]byte, 17+2)
				b[12] = 1 // side = Right
				binary.LittleEndian.PutUint32(b[13:17], 5)
				return b
			}(),
			"truncated_chars",
		},
		{
			"truncated_chars_length_overflow",
			func() []byte {
				// char_count = u32_max → would-be 8.5GB read; decoder must
				// detect off+need_bytes > buf.len before allocating.
				b := make([]byte, 17)
				b[12] = 1
				binary.LittleEndian.PutUint32(b[13:17], 0xFFFFFFFF)
				return b
			}(),
			"truncated_chars",
		},
	}

	for _, c := range negative {
		writeNegative("insert_v0", c.name, c.bytes, c.errorKind)
	}
}

// ---- insert_bytes_v0 ----

type insertBytesValue struct {
	Type     string     `json:"type"`
	Id       nodeIdJSON `json:"id"`
	Parent   nodeIdJSON `json:"parent"`
	Side     string     `json:"side"`
	BytesHex string     `json:"bytes_hex"`
}

func writeInsertBytesV0Positive() {
	allBytes := make([]byte, 256)
	for i := range allBytes {
		allBytes[i] = byte(i)
	}
	large := make([]byte, 4096)
	for i := range large {
		large[i] = byte(i % 251)
	}

	cases := []struct {
		name   string
		id     serde.NodeIdV0
		parent serde.NodeIdV0
		side   serde.InsertV0Side
		bytes  []byte
	}{
		{"empty_bytes_left", serde.NodeIdV0{ReplicaId: 1, Sequence: 10}, serde.NodeIdV0{ReplicaId: 1, Sequence: 9}, serde.InsertV0SideLeft, []byte{}},
		{"ascii_hi_right", serde.NodeIdV0{ReplicaId: 7, Sequence: 100}, serde.NodeIdV0{ReplicaId: 7, Sequence: 99}, serde.InsertV0SideRight, []byte("Hi")},
		{"ascii_hello_world_right", serde.NodeIdV0{ReplicaId: 2, Sequence: 50}, serde.NodeIdV0{ReplicaId: 2, Sequence: 49}, serde.InsertV0SideRight, []byte("Hello, world!")},
		{"root_insert", serde.NodeIdV0{ReplicaId: 1, Sequence: 1}, serde.NodeIdV0{ReplicaId: 0, Sequence: 0}, serde.InsertV0SideRoot, []byte("A")},
		{"all_byte_values", serde.NodeIdV0{ReplicaId: 5, Sequence: 200}, serde.NodeIdV0{ReplicaId: 5, Sequence: 199}, serde.InsertV0SideRight, allBytes},
		{"nul_and_high_bytes", serde.NodeIdV0{ReplicaId: 3, Sequence: 7}, serde.NodeIdV0{ReplicaId: 3, Sequence: 6}, serde.InsertV0SideRight, []byte{0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF, 0x00}},
		{"large_bytes_right", serde.NodeIdV0{ReplicaId: 9, Sequence: 1}, serde.NodeIdV0{ReplicaId: 9, Sequence: 0}, serde.InsertV0SideRight, large},
		{"endian_probe", serde.NodeIdV0{ReplicaId: 0x0201, Sequence: 0x06050403}, serde.NodeIdV0{ReplicaId: 0x0A09, Sequence: 0x0E0D0C0B}, serde.InsertV0SideRight, []byte{0xDE, 0xAD, 0xBE, 0xEF}},
	}

	for _, c := range cases {
		buf := make([]byte, serde.InsertBytesV0EncodedSize(len(c.bytes)))
		serde.InsertBytesV0Encode(c.id, c.parent, c.side, c.bytes, buf)
		writePositive("insert_bytes_v0", c.name, buf, insertBytesValue{
			Type:     "insert_bytes_v0",
			Id:       nodeIdJSON{ReplicaId: c.id.ReplicaId, Sequence: c.id.Sequence},
			Parent:   nodeIdJSON{ReplicaId: c.parent.ReplicaId, Sequence: c.parent.Sequence},
			Side:     c.side.String(),
			BytesHex: hex.EncodeToString(c.bytes),
		})
	}
}

func writeInsertBytesV0Negative() {
	negative := []struct {
		name      string
		bytes     []byte
		errorKind string
	}{
		{"truncated_header_empty", []byte{}, "truncated_header"},
		{"truncated_header_partial", make([]byte, 10), "truncated_header"},
		{"invalid_side_byte", func() []byte {
			b := make([]byte, 17)
			b[12] = 99
			return b
		}(), "invalid_side"},
		{"invalid_side_high", func() []byte {
			b := make([]byte, 17)
			b[12] = 0xFF
			return b
		}(), "invalid_side"},
		{"truncated_bytes_short", func() []byte {
			b := make([]byte, 17+2)
			b[12] = 1
			binary.LittleEndian.PutUint32(b[13:17], 5)
			return b
		}(), "truncated_bytes"},
		{"truncated_bytes_length_overflow", func() []byte {
			b := make([]byte, 17)
			b[12] = 1
			binary.LittleEndian.PutUint32(b[13:17], 0xFFFFFFFF)
			return b
		}(), "truncated_bytes"},
	}

	for _, c := range negative {
		writeNegative("insert_bytes_v0", c.name, c.bytes, c.errorKind)
	}
}

// ---- node_id_v0 ----

type nodeIdValue struct {
	Type      string `json:"type"`
	ReplicaId uint16 `json:"replica_id"`
	Sequence  uint32 `json:"sequence"`
}

func writeNodeIdV0Positive() {
	cases := []struct {
		name string
		id   serde.NodeIdV0
	}{
		{"zero", serde.NodeIdV0{ReplicaId: 0, Sequence: 0}},
		{"small", serde.NodeIdV0{ReplicaId: 1, Sequence: 1}},
		{"max", serde.NodeIdV0{ReplicaId: 0xFFFF, Sequence: 0xFFFFFFFF}},
		{"big_replica_small_seq", serde.NodeIdV0{ReplicaId: 0xFFFF, Sequence: 1}},
		{"small_replica_big_seq", serde.NodeIdV0{ReplicaId: 1, Sequence: 0xFFFFFFFF}},
		{"endian_probe", serde.NodeIdV0{ReplicaId: 0x0201, Sequence: 0x06050403}},
	}
	for _, c := range cases {
		buf := make([]byte, serde.NodeIdV0Size)
		serde.NodeIdV0Encode(c.id, buf, 0)
		writePositive("node_id_v0", c.name, buf, nodeIdValue{
			Type:      "node_id_v0",
			ReplicaId: c.id.ReplicaId,
			Sequence:  c.id.Sequence,
		})
	}
}

// ---- multi_op_v0 ----

type nodeIdJSON struct {
	ReplicaId uint16 `json:"replica_id"`
	Sequence  uint32 `json:"sequence"`
}

type multiOpInnerJSON struct {
	Disc       uint16 `json:"disc"`
	PayloadHex string `json:"payload_hex"`
}

type multiOpValue struct {
	Type    string             `json:"type"`
	GroupId nodeIdJSON         `json:"group_id"`
	Ops     []multiOpInnerJSON `json:"ops"`
}

// repeat returns a byte slice of `n` copies of `b`.
func repeat(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

func writeMultiOpV0Positive() {
	hide16 := repeat(0xAA, 16)
	show16 := repeat(0xBB, 16)
	hide16b := repeat(0xCC, 16)
	show16b := repeat(0xDD, 16)
	insertTiny := []byte{0xDE, 0xAD, 0xBE, 0xEF}
	insertBytesTiny := []byte{0x00, 0x01, 0xFE, 0xFF}
	insertEmpty := []byte{}
	insert1k := repeat(0x42, 1024)

	cases := []struct {
		name    string
		groupId serde.NodeIdV0
		ops     []serde.MultiOpV0InnerOp
	}{
		{
			"empty_batch",
			serde.NodeIdV0{ReplicaId: 7, Sequence: 42},
			[]serde.MultiOpV0InnerOp{},
		},
		{
			"single_hide",
			serde.NodeIdV0{ReplicaId: 1, Sequence: 100},
			[]serde.MultiOpV0InnerOp{{Disc: 1, Payload: hide16}},
		},
		{
			"single_show",
			serde.NodeIdV0{ReplicaId: 1, Sequence: 101},
			[]serde.MultiOpV0InnerOp{{Disc: 2, Payload: show16}},
		},
		{
			"single_insert_small",
			serde.NodeIdV0{ReplicaId: 1, Sequence: 200},
			[]serde.MultiOpV0InnerOp{{Disc: 0, Payload: insertTiny}},
		},
		{
			"single_insert_empty",
			serde.NodeIdV0{ReplicaId: 1, Sequence: 201},
			[]serde.MultiOpV0InnerOp{{Disc: 0, Payload: insertEmpty}},
		},
		{
			"single_insert_bytes",
			serde.NodeIdV0{ReplicaId: 1, Sequence: 202},
			[]serde.MultiOpV0InnerOp{{Disc: 6, Payload: insertBytesTiny}},
		},
		{
			"mixed_insert_kinds",
			serde.NodeIdV0{ReplicaId: 1, Sequence: 203},
			[]serde.MultiOpV0InnerOp{
				{Disc: 0, Payload: insertTiny},
				{Disc: 6, Payload: insertBytesTiny},
			},
		},
		{
			"one_of_each",
			serde.NodeIdV0{ReplicaId: 0x1234, Sequence: 0xCAFEBABE},
			[]serde.MultiOpV0InnerOp{
				{Disc: 1, Payload: hide16},
				{Disc: 0, Payload: insertTiny},
				{Disc: 2, Payload: show16},
			},
		},
		{
			"mixed_order",
			serde.NodeIdV0{ReplicaId: 5, Sequence: 999},
			[]serde.MultiOpV0InnerOp{
				{Disc: 1, Payload: hide16},
				{Disc: 2, Payload: show16},
				{Disc: 0, Payload: insertTiny},
				{Disc: 2, Payload: show16b},
				{Disc: 1, Payload: hide16b},
			},
		},
		{
			"large_insert",
			serde.NodeIdV0{ReplicaId: 9, Sequence: 1},
			[]serde.MultiOpV0InnerOp{{Disc: 0, Payload: insert1k}},
		},
		{
			"many_hides",
			serde.NodeIdV0{ReplicaId: 2, Sequence: 50},
			func() []serde.MultiOpV0InnerOp {
				ops := make([]serde.MultiOpV0InnerOp, 100)
				for i := range ops {
					ops[i] = serde.MultiOpV0InnerOp{Disc: 1, Payload: hide16}
				}
				return ops
			}(),
		},
	}

	for _, c := range cases {
		buf := make([]byte, serde.MultiOpV0EncodedSize(c.ops, 0))
		serde.MultiOpV0Encode(c.groupId, c.ops, nil, buf)

		opsJSON := make([]multiOpInnerJSON, len(c.ops))
		for i, op := range c.ops {
			opsJSON[i] = multiOpInnerJSON{
				Disc:       op.Disc,
				PayloadHex: hex.EncodeToString(op.Payload),
			}
		}
		writePositive("multi_op_v0", c.name, buf, multiOpValue{
			Type:    "multi_op_v0",
			GroupId: nodeIdJSON{ReplicaId: c.groupId.ReplicaId, Sequence: c.groupId.Sequence},
			Ops:     opsJSON,
		})
	}
}

// ---- multi_op_v0 negative ----
//
// Error kinds (all three languages must map their native error to one of these):
//
//   truncated_header        bytes shorter than 10 (group_id + op_count)
//   truncated_op_disc       op_count > 0 but no disc byte for the next op
//   truncated_op_len        variable op disc but no u32 length prefix
//   truncated_op_payload    op header parsed but declared payload runs off end
//   truncated_fixed_op      fixed op disc but fewer than expected payload bytes
//   unknown_inner_disc      disc byte is not a recognized inner op

func writeMultiOpV0Negative() {
	negative := []struct {
		name      string
		bytes     []byte
		errorKind string
	}{
		{
			"truncated_header_empty",
			[]byte{},
			"truncated_header",
		},
		{
			"truncated_header_partial",
			[]byte{1, 2, 3, 4, 5}, // 5 < 10
			"truncated_header",
		},
		{
			"truncated_op_disc",
			func() []byte {
				// group_id (6B zeros) + op_count=1, but no disc bytes
				b := make([]byte, 10)
				binary.LittleEndian.PutUint32(b[6:10], 1)
				return b
			}(),
			"truncated_op_disc",
		},
		{
			"truncated_op_disc_partial",
			func() []byte {
				// op_count=1, only 1 byte of u16 disc
				b := make([]byte, 11)
				binary.LittleEndian.PutUint32(b[6:10], 1)
				return b
			}(),
			"truncated_op_disc",
		},
		{
			"truncated_op_len_for_insert",
			func() []byte {
				// group_id + op_count=1 + disc=0 (insert, u16 LE), but no len bytes
				b := make([]byte, 12)
				binary.LittleEndian.PutUint32(b[6:10], 1)
				binary.LittleEndian.PutUint16(b[10:12], 0)
				return b
			}(),
			"truncated_op_len",
		},
		{
			"truncated_op_payload_insert",
			func() []byte {
				// op_count=1, disc=0 insert (u16), len=10, but only 4 bytes follow
				b := make([]byte, 6+4+2+4+4)
				binary.LittleEndian.PutUint32(b[6:10], 1)
				binary.LittleEndian.PutUint16(b[10:12], 0)
				binary.LittleEndian.PutUint32(b[12:16], 10)
				b[16], b[17], b[18], b[19] = 1, 2, 3, 4
				return b
			}(),
			"truncated_op_payload",
		},
		{
			"truncated_fixed_hide_op",
			func() []byte {
				// op_count=1, disc=1 hide (u16, expects 16B payload), only 5B follow
				b := make([]byte, 6+4+2+5)
				binary.LittleEndian.PutUint32(b[6:10], 1)
				binary.LittleEndian.PutUint16(b[10:12], 1)
				return b
			}(),
			"truncated_fixed_op",
		},
		{
			"unknown_inner_disc",
			func() []byte {
				// op_count=1, disc=0x9999 (unknown, u16 LE)
				b := make([]byte, 12)
				binary.LittleEndian.PutUint32(b[6:10], 1)
				binary.LittleEndian.PutUint16(b[10:12], 0x9999)
				return b
			}(),
			"unknown_inner_disc",
		},
		{
			"unknown_inner_disc_high",
			func() []byte {
				b := make([]byte, 12)
				binary.LittleEndian.PutUint32(b[6:10], 1)
				binary.LittleEndian.PutUint16(b[10:12], 0xFFFF)
				return b
			}(),
			"unknown_inner_disc",
		},
		{
			"length_overflow",
			func() []byte {
				// op_count=1, disc=0 insert (u16), len=u32_max, no payload —
				// decoders must detect that off+len > buf.len before allocating.
				b := make([]byte, 6+4+2+4)
				binary.LittleEndian.PutUint32(b[6:10], 1)
				binary.LittleEndian.PutUint16(b[10:12], 0)
				binary.LittleEndian.PutUint32(b[12:16], 0xFFFFFFFF)
				return b
			}(),
			"truncated_op_payload",
		},
	}

	for _, c := range negative {
		writeNegative("multi_op_v0", c.name, c.bytes, c.errorKind)
	}
}

// ---- helpers ----

func writePositive(typ, name string, bytes []byte, value any) {
	dir := filepath.Join(outRoot, "positive", typ, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bytes.bin"), bytes, 0o644); err != nil {
		fail("write bytes.bin: %v", err)
	}
	j, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fail("marshal value.json: %v", err)
	}
	j = append(j, '\n')
	if err := os.WriteFile(filepath.Join(dir, "value.json"), j, 0o644); err != nil {
		fail("write value.json: %v", err)
	}
}

func writeNegative(typ, name string, bytes []byte, errorKind string) {
	dir := filepath.Join(outRoot, "negative", typ, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bytes.bin"), bytes, 0o644); err != nil {
		fail("write bytes.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "error.txt"), []byte(errorKind+"\n"), 0o644); err != nil {
		fail("write error.txt: %v", err)
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
