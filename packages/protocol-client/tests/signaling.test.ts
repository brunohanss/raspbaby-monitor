import { describe, expect, test } from "vitest";
import { createAnswer, createOffer, MAX_MESSAGE_BYTES, MAX_SDP_BYTES, parseSignalingMessage } from "../src";

describe("local signaling contract", () => {
  test("round trips both kinds and ignores optional fields", () => {
    for (const make of [createOffer, createAnswer]) {
      const message = make("spike-1", "v=0\r\n");
      expect(parseSignalingMessage(JSON.stringify({ ...message, future_field: true }))).toEqual(message);
    }
  });

  test("rejects unsupported major versions, types and malformed input", () => {
    const message = createOffer("s", "v=0");
    for (const changed of [{ protocol_version: 2 }, { protocol_version: "1" }, { type: "system.heartbeat" }, { sdp: null }, { session_id: "bad id" }, { session_id: "" }, { session_id: "s".repeat(65) }]) {
      expect(() => parseSignalingMessage(JSON.stringify({ ...message, ...changed }))).toThrow();
    }
    for (const raw of ["[]", "null", "{}", "{"]) expect(() => parseSignalingMessage(raw)).toThrow();
  });

  test("uses UTF-8 byte limits before parsing", () => {
    expect(() => parseSignalingMessage(" ".repeat(MAX_MESSAGE_BYTES + 1))).toThrow();
    expect(createOffer("s", "x".repeat(MAX_SDP_BYTES)).sdp.length).toBe(MAX_SDP_BYTES);
    for (const sdp of ["", "x".repeat(MAX_SDP_BYTES + 1), "é".repeat(MAX_SDP_BYTES / 2 + 1)]) {
      expect(() => createAnswer("s", sdp)).toThrow();
    }
  });
});
