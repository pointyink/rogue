package serde

// The engine's control messages ride `json_envelope_v0` (disc 5): a UTF-8 JSON
// object whose "type" field names the message. The codec itself stays a
// pass-through (json_envelope_v0.go); these are the *schemas* for the messages
// the engine sends or parses, defined once here so the Go server and the JS
// client cannot disagree about a field name. (They did: `max` on the wire vs
// `MaxSeq` in a Go struct without a tag decoded as 0, silently.)
//
// Rules:
//   - a "type" string is immutable once shipped — a client in the field compares
//     it literally, so renaming one breaks every older client;
//   - fields are additive: a new field is optional, and unknown keys are ignored
//     by both decoders. That is why these are JSON and not a byte struct: adding
//     a byte field means minting a new discriminator.
//
// Host-defined messages (comments, usage limits, doc deletion) are deliberately
// not here: the engine forwards them opaquely by type. The registry that keeps
// the two sets from colliding lives with the service (docs/json-envelopes.md).

import (
	"encoding/json"
	"fmt"
)

// Message types the engine speaks. See the immutability rule above.
const (
	JsonTypeSyncStart      = "sync_start"
	JsonTypeSyncDone       = "sync_done"
	JsonTypeSyncCounts     = "sync_counts"
	JsonTypeSyncRejections = "sync_rejections"
	JsonTypeRejectOp       = "reject_op"
)

// SyncStart precedes the op stream: the total byte size of what is coming, so the
// client can pre-grow its CRDT storage and show progress.
type SyncStart struct {
	Type  string `json:"type"`
	Bytes int    `json:"bytes"`
}

// SyncDone marks the end of the op stream; the client may start replaying its own
// unacked queue.
type SyncDone struct {
	Type string `json:"type"`
}

// OpCount is what the server holds for one replica. Two numbers, because one is
// not enough: `n` catches a missing middle op, `max` catches a missing tail.
type OpCount struct {
	N      uint64 `json:"n"`
	MaxSeq uint64 `json:"max"`
}

// SyncCounts is the server's inventory, compared with the client's cache. A
// larger server count is an op the client never received — the one failure
// `since` cannot express, because a per-replica maximum cannot see a hole below
// it.
type SyncCounts struct {
	Type   string             `json:"type"`
	Counts map[uint16]OpCount `json:"counts"`
}

// SyncRejections carries recorded verdicts: `"<replica>:<seq>"` → the engine
// version that could not render that op. The op is still in the stream; this only
// saves the client from discovering it by walking back a broken render.
type SyncRejections struct {
	Type     string            `json:"type"`
	Rejected map[string]string `json:"rejected"`
}

// RejectOp is a client's verdict that its engine cannot render one op.
type RejectOp struct {
	Type    string `json:"type"`
	GID     string `json:"gid"`
	Version string `json:"version"`
}

// EncodeSyncStart returns the payload for the outer json_envelope_v0 frame.
func EncodeSyncStart(bytes int) ([]byte, error) {
	return json.Marshal(SyncStart{Type: JsonTypeSyncStart, Bytes: bytes})
}

// EncodeSyncDone returns the payload for the outer json_envelope_v0 frame. It has
// no fields: the type is the message.
func EncodeSyncDone() ([]byte, error) {
	return json.Marshal(SyncDone{Type: JsonTypeSyncDone})
}

// EncodeSyncCounts returns the payload. Go marshals map keys in sorted order, so
// the bytes are stable — which is what makes them usable in a fixture.
func EncodeSyncCounts(counts map[uint16]OpCount) ([]byte, error) {
	if counts == nil {
		counts = map[uint16]OpCount{}
	}
	return json.Marshal(SyncCounts{Type: JsonTypeSyncCounts, Counts: counts})
}

// EncodeSyncRejections returns the payload. Map keys are sorted, as above.
func EncodeSyncRejections(rejected map[string]string) ([]byte, error) {
	if rejected == nil {
		rejected = map[string]string{}
	}
	return json.Marshal(SyncRejections{Type: JsonTypeSyncRejections, Rejected: rejected})
}

// EncodeRejectOp returns the payload.
func EncodeRejectOp(gid, version string) ([]byte, error) {
	if gid == "" || version == "" {
		return nil, fmt.Errorf("json_envelopes: reject_op needs a gid and a version")
	}
	return json.Marshal(RejectOp{Type: JsonTypeRejectOp, GID: gid, Version: version})
}

// DecodeSyncStart parses a payload, rejecting a different message type. Unknown
// fields are ignored, so a server may add one without breaking this client.
func DecodeSyncStart(b []byte) (SyncStart, error) {
	var m SyncStart
	if err := decodeTyped(b, JsonTypeSyncStart, &m); err != nil {
		return m, err
	}
	return m, nil
}

// DecodeSyncDone parses a payload.
func DecodeSyncDone(b []byte) (SyncDone, error) {
	var m SyncDone
	if err := decodeTyped(b, JsonTypeSyncDone, &m); err != nil {
		return m, err
	}
	return m, nil
}

// DecodeSyncCounts parses a payload.
func DecodeSyncCounts(b []byte) (SyncCounts, error) {
	m := SyncCounts{Counts: map[uint16]OpCount{}}
	if err := decodeTyped(b, JsonTypeSyncCounts, &m); err != nil {
		return SyncCounts{}, err
	}
	return m, nil
}

// DecodeSyncRejections parses a payload.
func DecodeSyncRejections(b []byte) (SyncRejections, error) {
	m := SyncRejections{Rejected: map[string]string{}}
	if err := decodeTyped(b, JsonTypeSyncRejections, &m); err != nil {
		return SyncRejections{}, err
	}
	return m, nil
}

// DecodeRejectOp parses a payload.
func DecodeRejectOp(b []byte) (RejectOp, error) {
	var m RejectOp
	if err := decodeTyped(b, JsonTypeRejectOp, &m); err != nil {
		return m, err
	}
	return m, nil
}

// JsonTypeOf returns just the "type" field, for dispatch. An empty string means
// the payload is not a JSON object with a type — the caller should ignore it.
func JsonTypeOf(b []byte) string {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		return ""
	}
	return probe.Type
}

// decodeTyped unmarshals and checks the message type, so a dispatcher that routes
// by type cannot silently accept the wrong shape.
func decodeTyped(b []byte, want string, out any) error {
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("json_envelopes: %s: %w", want, err)
	}
	got := JsonTypeOf(b)
	if got != want {
		return fmt.Errorf("json_envelopes: got type %q, want %q", got, want)
	}
	return nil
}
