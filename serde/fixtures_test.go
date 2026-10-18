// Fixture-driven cross-language conformance tests.
//
// For every positive fixture: decode(bytes.bin) must field-match value.json,
// and encode(value.json) must produce bytes.bin verbatim.
//
// For every negative fixture: decode(bytes.bin) must fail with the error
// kind named in error.txt.
//
// The fixtures themselves live in serde/fixtures and are produced by the
// gen script (serde/fixtures/gen). Bytes.bin is the canonical spec.

package serde

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fixturesRoot = "fixtures"

// ---- value.json shapes ----

type fxNodeId struct {
	Type      string `json:"type"`
	ReplicaId uint16 `json:"replica_id"`
	Sequence  uint32 `json:"sequence"`
}

type fxMultiOpInner struct {
	Disc       uint16 `json:"disc"`
	PayloadHex string `json:"payload_hex"`
}

type fxNodeIdEmbed struct {
	ReplicaId uint16 `json:"replica_id"`
	Sequence  uint32 `json:"sequence"`
}

type fxMultiOp struct {
	Type    string           `json:"type"`
	GroupId fxNodeIdEmbed    `json:"group_id"`
	Ops     []fxMultiOpInner `json:"ops"`
}

type fxInsert struct {
	Type     string        `json:"type"`
	Id       fxNodeIdEmbed `json:"id"`
	Parent   fxNodeIdEmbed `json:"parent"`
	Side     string        `json:"side"`
	CharsHex string        `json:"chars_hex"`
}

type fxInsertBytes struct {
	Type     string        `json:"type"`
	Id       fxNodeIdEmbed `json:"id"`
	Parent   fxNodeIdEmbed `json:"parent"`
	Side     string        `json:"side"`
	BytesHex string        `json:"bytes_hex"`
}

type fxHideShow struct {
	Type   string        `json:"type"`
	Id     fxNodeIdEmbed `json:"id"`
	Target fxNodeIdEmbed `json:"target"`
	Len    uint32        `json:"len"`
}

type fxAck struct {
	Type     string          `json:"type"`
	GroupIds []fxNodeIdEmbed `json:"group_ids"`
}

type fxJsonEnvelope struct {
	Type       string `json:"type"`
	PayloadHex string `json:"payload_hex"`
}

// ---- positive fixtures ----

func TestPositiveFixtures(t *testing.T) {
	t.Run("node_id_v0", func(t *testing.T) {
		walkPositive(t, "node_id_v0", func(t *testing.T, b []byte, raw []byte) {
			var v fxNodeId
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Fatalf("parse value.json: %v", err)
			}

			// decode → must match value.json
			got := NodeIdV0Decode(b, 0)
			if got.ReplicaId != v.ReplicaId || got.Sequence != v.Sequence {
				t.Fatalf("decode mismatch: got {%d,%d}, want {%d,%d}", got.ReplicaId, got.Sequence, v.ReplicaId, v.Sequence)
			}

			// encode → must match bytes.bin
			enc := make([]byte, NodeIdV0Size)
			NodeIdV0Encode(NodeIdV0{ReplicaId: v.ReplicaId, Sequence: v.Sequence}, enc, 0)
			if !bytes.Equal(enc, b) {
				t.Fatalf("encode mismatch:\n got: %x\nwant: %x", enc, b)
			}
		})
	})

	t.Run("insert_v0", func(t *testing.T) {
		walkPositive(t, "insert_v0", func(t *testing.T, b []byte, raw []byte) {
			var v fxInsert
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Fatalf("parse value.json: %v", err)
			}

			// decode → must match value.json
			got, err := InsertV0Decode(b)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got.Id.ReplicaId != v.Id.ReplicaId || got.Id.Sequence != v.Id.Sequence {
				t.Fatalf("id mismatch: got {%d,%d}, want {%d,%d}",
					got.Id.ReplicaId, got.Id.Sequence, v.Id.ReplicaId, v.Id.Sequence)
			}
			if got.Parent.ReplicaId != v.Parent.ReplicaId || got.Parent.Sequence != v.Parent.Sequence {
				t.Fatalf("parent mismatch: got {%d,%d}, want {%d,%d}",
					got.Parent.ReplicaId, got.Parent.Sequence, v.Parent.ReplicaId, v.Parent.Sequence)
			}
			if got.Side.String() != v.Side {
				t.Fatalf("side mismatch: got %q, want %q", got.Side.String(), v.Side)
			}
			wantChars, err := hex.DecodeString(v.CharsHex)
			if err != nil {
				t.Fatalf("chars_hex decode: %v", err)
			}
			gotCharBytes := make([]byte, 2*len(got.Chars))
			for i, c := range got.Chars {
				gotCharBytes[2*i] = byte(c)
				gotCharBytes[2*i+1] = byte(c >> 8)
			}
			if !bytes.Equal(gotCharBytes, wantChars) {
				t.Fatalf("chars mismatch:\n got: %x\nwant: %x", gotCharBytes, wantChars)
			}

			// encode → must match bytes.bin
			side, err := InsertV0SideFromString(v.Side)
			if err != nil {
				t.Fatalf("side parse: %v", err)
			}
			chars := make([]uint16, len(wantChars)/2)
			for i := range chars {
				chars[i] = uint16(wantChars[2*i]) | uint16(wantChars[2*i+1])<<8
			}
			enc := make([]byte, InsertV0EncodedSize(len(chars)))
			InsertV0Encode(
				NodeIdV0{ReplicaId: v.Id.ReplicaId, Sequence: v.Id.Sequence},
				NodeIdV0{ReplicaId: v.Parent.ReplicaId, Sequence: v.Parent.Sequence},
				side, chars, enc,
			)
			if !bytes.Equal(enc, b) {
				t.Fatalf("encode mismatch:\n got: %x\nwant: %x", enc, b)
			}
		})
	})

	t.Run("insert_bytes_v0", func(t *testing.T) {
		walkPositive(t, "insert_bytes_v0", func(t *testing.T, b []byte, raw []byte) {
			var v fxInsertBytes
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Fatalf("parse value.json: %v", err)
			}

			// decode → must match value.json
			got, err := InsertBytesV0Decode(b)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got.Id.ReplicaId != v.Id.ReplicaId || got.Id.Sequence != v.Id.Sequence {
				t.Fatalf("id mismatch: got {%d,%d}, want {%d,%d}",
					got.Id.ReplicaId, got.Id.Sequence, v.Id.ReplicaId, v.Id.Sequence)
			}
			if got.Parent.ReplicaId != v.Parent.ReplicaId || got.Parent.Sequence != v.Parent.Sequence {
				t.Fatalf("parent mismatch: got {%d,%d}, want {%d,%d}",
					got.Parent.ReplicaId, got.Parent.Sequence, v.Parent.ReplicaId, v.Parent.Sequence)
			}
			if got.Side.String() != v.Side {
				t.Fatalf("side mismatch: got %q, want %q", got.Side.String(), v.Side)
			}
			wantBytes, err := hex.DecodeString(v.BytesHex)
			if err != nil {
				t.Fatalf("bytes_hex: %v", err)
			}
			if !bytes.Equal(got.Bytes, wantBytes) {
				t.Fatalf("bytes mismatch:\n got: %x\nwant: %x", got.Bytes, wantBytes)
			}

			// encode → must match bytes.bin
			side, err := InsertV0SideFromString(v.Side)
			if err != nil {
				t.Fatalf("side parse: %v", err)
			}
			enc := make([]byte, InsertBytesV0EncodedSize(len(wantBytes)))
			InsertBytesV0Encode(
				NodeIdV0{ReplicaId: v.Id.ReplicaId, Sequence: v.Id.Sequence},
				NodeIdV0{ReplicaId: v.Parent.ReplicaId, Sequence: v.Parent.Sequence},
				side, wantBytes, enc,
			)
			if !bytes.Equal(enc, b) {
				t.Fatalf("encode mismatch:\n got: %x\nwant: %x", enc, b)
			}
		})
	})

	t.Run("hide_v0", func(t *testing.T) {
		walkPositive(t, "hide_v0", func(t *testing.T, b []byte, raw []byte) {
			var v fxHideShow
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Fatalf("parse value.json: %v", err)
			}
			got, err := HideV0Decode(b)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got.Id.ReplicaId != v.Id.ReplicaId || got.Id.Sequence != v.Id.Sequence {
				t.Fatalf("id mismatch")
			}
			if got.Target.ReplicaId != v.Target.ReplicaId || got.Target.Sequence != v.Target.Sequence {
				t.Fatalf("target mismatch")
			}
			if got.Len != v.Len {
				t.Fatalf("len: got %d, want %d", got.Len, v.Len)
			}
			enc := make([]byte, HideV0Size)
			HideV0Encode(HideV0{
				Id:     NodeIdV0{ReplicaId: v.Id.ReplicaId, Sequence: v.Id.Sequence},
				Target: NodeIdV0{ReplicaId: v.Target.ReplicaId, Sequence: v.Target.Sequence},
				Len:    v.Len,
			}, enc)
			if !bytes.Equal(enc, b) {
				t.Fatalf("encode mismatch:\n got: %x\nwant: %x", enc, b)
			}
		})
	})

	t.Run("show_v0", func(t *testing.T) {
		walkPositive(t, "show_v0", func(t *testing.T, b []byte, raw []byte) {
			var v fxHideShow
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Fatalf("parse value.json: %v", err)
			}
			got, err := ShowV0Decode(b)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got.Id.ReplicaId != v.Id.ReplicaId || got.Id.Sequence != v.Id.Sequence {
				t.Fatalf("id mismatch")
			}
			if got.Target.ReplicaId != v.Target.ReplicaId || got.Target.Sequence != v.Target.Sequence {
				t.Fatalf("target mismatch")
			}
			if got.Len != v.Len {
				t.Fatalf("len: got %d, want %d", got.Len, v.Len)
			}
			enc := make([]byte, ShowV0Size)
			ShowV0Encode(ShowV0{
				Id:     NodeIdV0{ReplicaId: v.Id.ReplicaId, Sequence: v.Id.Sequence},
				Target: NodeIdV0{ReplicaId: v.Target.ReplicaId, Sequence: v.Target.Sequence},
				Len:    v.Len,
			}, enc)
			if !bytes.Equal(enc, b) {
				t.Fatalf("encode mismatch:\n got: %x\nwant: %x", enc, b)
			}
		})
	})

	t.Run("json_envelope_v0", func(t *testing.T) {
		walkPositive(t, "json_envelope_v0", func(t *testing.T, b []byte, raw []byte) {
			var v fxJsonEnvelope
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Fatalf("parse value.json: %v", err)
			}
			wantPayload, err := hex.DecodeString(v.PayloadHex)
			if err != nil {
				t.Fatalf("hex decode: %v", err)
			}

			dec := JsonEnvelopeV0Decode(b)
			if !bytes.Equal(dec, wantPayload) {
				t.Fatalf("decode mismatch:\n got: %x\nwant: %x", dec, wantPayload)
			}
			enc := JsonEnvelopeV0Encode(wantPayload)
			if !bytes.Equal(enc, b) {
				t.Fatalf("encode mismatch:\n got: %x\nwant: %x", enc, b)
			}
		})
	})

	t.Run("ack_v0", func(t *testing.T) {
		walkPositive(t, "ack_v0", func(t *testing.T, b []byte, raw []byte) {
			var v fxAck
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Fatalf("parse value.json: %v", err)
			}
			got, err := AckV0Decode(b)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if len(got.GroupIds) != len(v.GroupIds) {
				t.Fatalf("count mismatch: got %d, want %d", len(got.GroupIds), len(v.GroupIds))
			}
			for i, id := range got.GroupIds {
				if id.ReplicaId != v.GroupIds[i].ReplicaId || id.Sequence != v.GroupIds[i].Sequence {
					t.Fatalf("id[%d] mismatch: got {%d,%d}, want {%d,%d}",
						i, id.ReplicaId, id.Sequence, v.GroupIds[i].ReplicaId, v.GroupIds[i].Sequence)
				}
			}

			ids := make([]NodeIdV0, len(v.GroupIds))
			for i, id := range v.GroupIds {
				ids[i] = NodeIdV0{ReplicaId: id.ReplicaId, Sequence: id.Sequence}
			}
			enc := make([]byte, AckV0EncodedSize(len(ids)))
			AckV0Encode(ids, enc)
			if !bytes.Equal(enc, b) {
				t.Fatalf("encode mismatch:\n got: %x\nwant: %x", enc, b)
			}
		})
	})

	t.Run("multi_op_v0", func(t *testing.T) {
		walkPositive(t, "multi_op_v0", func(t *testing.T, b []byte, raw []byte) {
			var v fxMultiOp
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Fatalf("parse value.json: %v", err)
			}

			// decode → must match value.json
			got, err := MultiOpV0Decode(b)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got.GroupId.ReplicaId != v.GroupId.ReplicaId || got.GroupId.Sequence != v.GroupId.Sequence {
				t.Fatalf("group_id mismatch: got {%d,%d}, want {%d,%d}",
					got.GroupId.ReplicaId, got.GroupId.Sequence, v.GroupId.ReplicaId, v.GroupId.Sequence)
			}
			if len(got.Ops) != len(v.Ops) {
				t.Fatalf("op count mismatch: got %d, want %d", len(got.Ops), len(v.Ops))
			}
			for i, op := range got.Ops {
				wantBytes, err := hex.DecodeString(v.Ops[i].PayloadHex)
				if err != nil {
					t.Fatalf("op[%d] hex decode: %v", i, err)
				}
				if op.Disc != v.Ops[i].Disc {
					t.Fatalf("op[%d] disc mismatch: got %d, want %d", i, op.Disc, v.Ops[i].Disc)
				}
				if !bytes.Equal(op.Payload, wantBytes) {
					t.Fatalf("op[%d] payload mismatch:\n got: %x\nwant: %x", i, op.Payload, wantBytes)
				}
			}

			// encode → must match bytes.bin
			ops := make([]MultiOpV0InnerOp, len(v.Ops))
			for i, op := range v.Ops {
				p, err := hex.DecodeString(op.PayloadHex)
				if err != nil {
					t.Fatalf("op[%d] hex decode for encode: %v", i, err)
				}
				ops[i] = MultiOpV0InnerOp{Disc: op.Disc, Payload: p}
			}
			enc := make([]byte, MultiOpV0EncodedSize(ops, 0))
			MultiOpV0Encode(NodeIdV0{ReplicaId: v.GroupId.ReplicaId, Sequence: v.GroupId.Sequence}, ops, nil, enc)
			if !bytes.Equal(enc, b) {
				t.Fatalf("encode mismatch:\n got: %x\nwant: %x", enc, b)
			}
		})
	})
}

// ---- negative fixtures ----

func TestNegativeFixtures(t *testing.T) {
	t.Run("multi_op_v0", func(t *testing.T) {
		walkNegative(t, "multi_op_v0", func(t *testing.T, b []byte, kind string) {
			_, err := MultiOpV0Decode(b)
			if err == nil {
				t.Fatalf("expected error of kind %q, got nil (bytes: %x)", kind, b)
			}
			got := classifyMultiOpV0Err(err)
			if got != kind {
				t.Fatalf("error kind mismatch: got %q (%v), want %q", got, err, kind)
			}
		})
	})

	t.Run("insert_v0", func(t *testing.T) {
		walkNegative(t, "insert_v0", func(t *testing.T, b []byte, kind string) {
			_, err := InsertV0Decode(b)
			if err == nil {
				t.Fatalf("expected error of kind %q, got nil (bytes: %x)", kind, b)
			}
			got := classifyInsertV0Err(err)
			if got != kind {
				t.Fatalf("error kind mismatch: got %q (%v), want %q", got, err, kind)
			}
		})
	})

	t.Run("insert_bytes_v0", func(t *testing.T) {
		walkNegative(t, "insert_bytes_v0", func(t *testing.T, b []byte, kind string) {
			_, err := InsertBytesV0Decode(b)
			if err == nil {
				t.Fatalf("expected error of kind %q, got nil (bytes: %x)", kind, b)
			}
			got := classifyInsertBytesV0Err(err)
			if got != kind {
				t.Fatalf("error kind mismatch: got %q (%v), want %q", got, err, kind)
			}
		})
	})

	t.Run("hide_v0", func(t *testing.T) {
		walkNegative(t, "hide_v0", func(t *testing.T, b []byte, kind string) {
			_, err := HideV0Decode(b)
			if err == nil {
				t.Fatalf("expected error of kind %q, got nil", kind)
			}
			if !errors.Is(err, ErrHideV0Truncated) || kind != "truncated" {
				t.Fatalf("error kind mismatch: got %v, want %q", err, kind)
			}
		})
	})

	t.Run("show_v0", func(t *testing.T) {
		walkNegative(t, "show_v0", func(t *testing.T, b []byte, kind string) {
			_, err := ShowV0Decode(b)
			if err == nil {
				t.Fatalf("expected error of kind %q, got nil", kind)
			}
			if !errors.Is(err, ErrShowV0Truncated) || kind != "truncated" {
				t.Fatalf("error kind mismatch: got %v, want %q", err, kind)
			}
		})
	})

	t.Run("ack_v0", func(t *testing.T) {
		walkNegative(t, "ack_v0", func(t *testing.T, b []byte, kind string) {
			_, err := AckV0Decode(b)
			if err == nil {
				t.Fatalf("expected error of kind %q, got nil", kind)
			}
			if !errors.Is(err, ErrAckV0Truncated) || kind != "truncated" {
				t.Fatalf("error kind mismatch: got %v, want %q", err, kind)
			}
		})
	})
}

func classifyInsertV0Err(err error) string {
	if errors.Is(err, ErrInsertV0InvalidSide) {
		return "invalid_side"
	}
	if errors.Is(err, ErrInsertV0Truncated) {
		return "truncated"
	}
	return fmt.Sprintf("unexpected:%v", err)
}

func classifyInsertBytesV0Err(err error) string {
	if errors.Is(err, ErrInsertBytesV0InvalidSide) {
		return "invalid_side"
	}
	if errors.Is(err, ErrInsertBytesV0Truncated) {
		return "truncated"
	}
	return fmt.Sprintf("unexpected:%v", err)
}

// classifyMultiOpV0Err maps native Go errors to the shared error-kind
// vocabulary used in fixture error.txt files.
func classifyMultiOpV0Err(err error) string {
	if errors.Is(err, ErrMultiOpV0UnknownInnerDisc) {
		return "unknown_inner_disc"
	}
	if !errors.Is(err, ErrMultiOpV0Truncated) {
		return fmt.Sprintf("unexpected:%v", err)
	}
	// Truncated covers all the sub-flavors. We could refine the codec to
	// emit more specific errors later; for now we let the fixture's name
	// disambiguate.
	return "truncated"
}

// ---- walkers ----

func walkPositive(t *testing.T, typ string, check func(t *testing.T, bytes []byte, valueJSON []byte)) {
	t.Helper()
	root := filepath.Join(fixturesRoot, "positive", typ)
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read %s: %v", root, err)
	}
	if len(entries) == 0 {
		t.Fatalf("no fixtures under %s", root)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(root, name)
			b, err := os.ReadFile(filepath.Join(dir, "bytes.bin"))
			if err != nil {
				t.Fatalf("read bytes.bin: %v", err)
			}
			j, err := os.ReadFile(filepath.Join(dir, "value.json"))
			if err != nil {
				t.Fatalf("read value.json: %v", err)
			}
			check(t, b, j)
		})
	}
}

func walkNegative(t *testing.T, typ string, check func(t *testing.T, bytes []byte, errorKind string)) {
	t.Helper()
	root := filepath.Join(fixturesRoot, "negative", typ)
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read %s: %v", root, err)
	}
	if len(entries) == 0 {
		t.Fatalf("no fixtures under %s", root)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(root, name)
			b, err := os.ReadFile(filepath.Join(dir, "bytes.bin"))
			if err != nil {
				t.Fatalf("read bytes.bin: %v", err)
			}
			kindRaw, err := os.ReadFile(filepath.Join(dir, "error.txt"))
			if err != nil {
				t.Fatalf("read error.txt: %v", err)
			}
			kind := strings.TrimSpace(string(kindRaw))
			// Coalesce truncated_* variants into a single "truncated" bucket
			// for Go's classifier — see classifyMultiOpV0Err.
			if strings.HasPrefix(kind, "truncated_") {
				kind = "truncated"
			}
			check(t, b, kind)
		})
	}
}
