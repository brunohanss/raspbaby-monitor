import {
  MAX_MESSAGE_BYTES,
  MAX_SDP_BYTES,
  MAX_SESSION_ID_BYTES,
  PROTOCOL_VERSION,
  type SignalingMessage,
} from "./generated";

export * from "./generated";
export { parseTelemetryMessage } from "./telemetry";

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Validate copied local signaling. This function does not authenticate a peer. */
export function parseSignalingMessage(raw: string): SignalingMessage {
  if (byteLength(raw) > MAX_MESSAGE_BYTES) throw new Error("Signaling message exceeds the size limit");
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a signaling object");
  }
  const message = value as Record<string, unknown>;
  if (message.protocol_version !== PROTOCOL_VERSION) throw new Error("Unsupported protocol major version");
  if (message.type !== "webrtc.offer" && message.type !== "webrtc.answer") throw new Error("Unsupported signaling type");
  if (
    typeof message.session_id !== "string" ||
    message.session_id.length > MAX_SESSION_ID_BYTES ||
    !/^[A-Za-z0-9_.-]+$/.test(message.session_id)
  ) throw new Error("Invalid signaling session ID");
  if (typeof message.sdp !== "string" || !message.sdp.length || byteLength(message.sdp) > MAX_SDP_BYTES) {
    throw new Error("SDP is empty or exceeds the size limit");
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    type: message.type,
    session_id: message.session_id,
    sdp: message.sdp,
  };
}

export function createOffer(sessionId: string, sdp: string): SignalingMessage {
  return parseSignalingMessage(JSON.stringify({ protocol_version: PROTOCOL_VERSION, type: "webrtc.offer", session_id: sessionId, sdp }));
}

export function createAnswer(sessionId: string, sdp: string): SignalingMessage {
  return parseSignalingMessage(JSON.stringify({ protocol_version: PROTOCOL_VERSION, type: "webrtc.answer", session_id: sessionId, sdp }));
}
