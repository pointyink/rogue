// json_envelope_v0 — pass-through wrapper for a UTF-8 JSON payload.
// See json_envelope_v0.md. The codec performs no parsing — bytes in,
// bytes out. Routing happens via a "type" field inside the JSON,
// interpreted by the application.
package serde

const JsonEnvelopeV0Disc uint16 = 5

// JsonEnvelopeV0Encode is identity. Provided for symmetry with the other
// codecs — encoders produce the bytes that the outer wire frame will
// length-prefix.
func JsonEnvelopeV0Encode(jsonBytes []byte) []byte {
	return jsonBytes
}

// JsonEnvelopeV0Decode is identity. The caller-supplied slice (already
// bounded by the outer wire frame's length) is the payload.
func JsonEnvelopeV0Decode(buf []byte) []byte {
	return buf
}
