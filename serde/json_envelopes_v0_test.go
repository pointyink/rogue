package serde

import (
	"bytes"
	"testing"
)

// The exact bytes matter: a server in the field sends them, a client in the field
// parses them, and both are pinned by these strings.
func TestEncodeJsonEnvelopesExactBytes(t *testing.T) {
	cases := []struct {
		name string
		got  func() ([]byte, error)
		want string
	}{
		{"sync_start", func() ([]byte, error) { return EncodeSyncStart(1234) }, `{"type":"sync_start","bytes":1234}`},
		{"sync_done", func() ([]byte, error) { return EncodeSyncDone() }, `{"type":"sync_done"}`},
		{"sync_counts", func() ([]byte, error) {
			// Go sorts map keys as strings, so "10" sorts before "2". The order is
			// deterministic, which is what a fixture needs; it is not numeric.
			return EncodeSyncCounts(map[uint16]OpCount{10: {N: 1, MaxSeq: 5}, 2: {N: 27, MaxSeq: 30873}})
		}, `{"type":"sync_counts","counts":{"10":{"n":1,"max":5},"2":{"n":27,"max":30873}}}`},
		{"sync_rejections", func() ([]byte, error) {
			return EncodeSyncRejections(map[string]string{"2:14": "0.5.1"})
		}, `{"type":"sync_rejections","rejected":{"2:14":"0.5.1"}}`},
		{"reject_op", func() ([]byte, error) { return EncodeRejectOp("2:14", "0.5.1") }, `{"type":"reject_op","gid":"2:14","version":"0.5.1"}`},
	}
	for _, c := range cases {
		b, err := c.got()
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if string(b) != c.want {
			t.Fatalf("%s:\n got %s\nwant %s", c.name, b, c.want)
		}
	}
}

func TestJsonEnvelopesRoundTrip(t *testing.T) {
	b, _ := EncodeSyncCounts(map[uint16]OpCount{7: {N: 3, MaxSeq: 42}})
	m, err := DecodeSyncCounts(b)
	if err != nil {
		t.Fatalf("DecodeSyncCounts: %v", err)
	}
	if m.Counts[7] != (OpCount{N: 3, MaxSeq: 42}) {
		t.Fatalf("round trip = %+v", m.Counts)
	}

	rb, _ := EncodeSyncRejections(map[string]string{"7:42": "9.9.9"})
	rm, err := DecodeSyncRejections(rb)
	if err != nil {
		t.Fatalf("DecodeSyncRejections: %v", err)
	}
	if rm.Rejected["7:42"] != "9.9.9" {
		t.Fatalf("round trip = %+v", rm.Rejected)
	}
}

// A dispatcher that routes by type must not accept the wrong shape: reading a
// counts payload as a rejections one would silently yield empty maps.
func TestDecodeRejectsWrongType(t *testing.T) {
	b, _ := EncodeSyncCounts(map[uint16]OpCount{1: {N: 1, MaxSeq: 1}})
	if _, err := DecodeSyncRejections(b); err == nil {
		t.Fatal("decoded a sync_counts payload as sync_rejections")
	}
	if _, err := DecodeRejectOp(b); err == nil {
		t.Fatal("decoded a sync_counts payload as reject_op")
	}
}

// Additive evolution: a server may add a field, and an older decoder ignores it.
func TestDecodeIgnoresUnknownFields(t *testing.T) {
	b := []byte(`{"type":"sync_counts","counts":{"1":{"n":2,"max":9}},"epoch":4}`)
	m, err := DecodeSyncCounts(b)
	if err != nil {
		t.Fatalf("DecodeSyncCounts: %v", err)
	}
	if m.Counts[1] != (OpCount{N: 2, MaxSeq: 9}) {
		t.Fatalf("counts = %+v", m.Counts)
	}
}

func TestJsonTypeOf(t *testing.T) {
	b, _ := EncodeSyncDone()
	if got := JsonTypeOf(b); got != JsonTypeSyncDone {
		t.Fatalf("JsonTypeOf = %q", got)
	}
	if got := JsonTypeOf([]byte("not json")); got != "" {
		t.Fatalf("JsonTypeOf(bad) = %q", got)
	}
	// A payload with no type is not routable.
	if got := JsonTypeOf([]byte(`{"counts":{}}`)); got != "" {
		t.Fatalf("JsonTypeOf(untyped) = %q", got)
	}
}

func TestEncodeRejectOpRequiresFields(t *testing.T) {
	if _, err := EncodeRejectOp("", "0.5.1"); err == nil {
		t.Fatal("accepted an empty gid")
	}
	if _, err := EncodeRejectOp("1:1", ""); err == nil {
		t.Fatal("accepted an empty version")
	}
}

// The payload must not carry the frame: the service prepends disc + length.
func TestJsonEnvelopesArePayloadOnly(t *testing.T) {
	b, _ := EncodeSyncDone()
	if bytes.HasPrefix(b, []byte{5, 0}) {
		t.Fatal("payload starts with the envelope disc; framing belongs to the caller")
	}
	if JsonEnvelopeV0Disc != 5 {
		t.Fatalf("JsonEnvelopeV0Disc = %d, want 5", JsonEnvelopeV0Disc)
	}
}
