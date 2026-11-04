//! Bounded analysis results. Do not include frames, PCM, or media credentials.

use crate::PROTOCOL_VERSION;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fmt};
use ts_rs::TS;

pub const MAX_TELEMETRY_BYTES: usize = 8192;
pub const MAX_TELEMETRY_EVENTS: usize = 32;
pub const MAX_TELEMETRY_ID_BYTES: usize = 64;
/// End of the supported Unix-millisecond range: 2100-01-01T00:00:00Z.
pub const MAX_TELEMETRY_TIMESTAMP_MS: u64 = 4_102_444_800_000;
pub const MAX_SAFE_COUNTER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum TelemetryKind {
    #[serde(rename = "monitor.telemetry")]
    MonitorTelemetry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryEventKind {
    Motion,
    Sound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TelemetryEvent {
    pub id: String,
    pub kind: TelemetryEventKind,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TelemetryMessage {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub kind: TelemetryKind,
    pub device_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    /// Pi CPU temperature when the source is the onboard thermal interface.
    /// This does not measure room or body temperature.
    pub temperature_c: Option<f32>,
    pub audio_level: Option<f32>,
    pub motion_active: bool,
    #[serde(default)]
    pub sound_active: bool,
    #[serde(default)]
    #[ts(type = "number")]
    pub dropped_events: u64,
    pub events: Vec<TelemetryEvent>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TelemetryError {
    MessageTooLarge,
    InvalidJson,
    UnsupportedVersion(u32),
    InvalidField(&'static str),
}

impl fmt::Display for TelemetryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MessageTooLarge => f.write_str("telemetry exceeds 8192 bytes"),
            Self::InvalidJson => f.write_str("invalid telemetry JSON or fields"),
            Self::UnsupportedVersion(version) => {
                write!(f, "unsupported telemetry major version {version}")
            }
            Self::InvalidField(field) => write!(f, "invalid telemetry field: {field}"),
        }
    }
}

impl std::error::Error for TelemetryError {}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TELEMETRY_ID_BYTES
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

impl TelemetryMessage {
    pub fn validate(&self) -> Result<(), TelemetryError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(TelemetryError::UnsupportedVersion(self.protocol_version));
        }
        let invalid = |field| Err(TelemetryError::InvalidField(field));
        if !valid_id(&self.device_id) {
            return invalid("device_id");
        }
        if self.sequence > MAX_SAFE_COUNTER {
            return invalid("sequence");
        }
        if self.dropped_events > MAX_SAFE_COUNTER {
            return invalid("dropped_events");
        }
        if self.timestamp_ms > MAX_TELEMETRY_TIMESTAMP_MS {
            return invalid("timestamp_ms");
        }
        if self
            .temperature_c
            .is_some_and(|c| !c.is_finite() || !(-40.0..=125.0).contains(&c))
        {
            return invalid("temperature_c");
        }
        if self
            .audio_level
            .is_some_and(|level| !level.is_finite() || !(0.0..=1.0).contains(&level))
        {
            return invalid("audio_level");
        }
        if self.events.len() > MAX_TELEMETRY_EVENTS {
            return invalid("events");
        }
        let mut ids = HashSet::with_capacity(self.events.len());
        for event in &self.events {
            if !valid_id(&event.id) || !ids.insert(&event.id) {
                return invalid("event.id");
            }
            if event.timestamp_ms > self.timestamp_ms {
                return invalid("event.timestamp_ms");
            }
        }
        Ok(())
    }
}

pub fn parse_telemetry(raw: &str) -> Result<TelemetryMessage, TelemetryError> {
    if raw.len() > MAX_TELEMETRY_BYTES {
        return Err(TelemetryError::MessageTooLarge);
    }
    let message: TelemetryMessage =
        serde_json::from_str(raw).map_err(|_| TelemetryError::InvalidJson)?;
    message.validate()?;
    Ok(message)
}

pub(crate) fn typescript() -> String {
    format!(
        "export {}\nexport {}\nexport {}\nexport {}\nexport const MAX_TELEMETRY_BYTES = {MAX_TELEMETRY_BYTES};\nexport const MAX_TELEMETRY_EVENTS = {MAX_TELEMETRY_EVENTS};\nexport const MAX_TELEMETRY_ID_BYTES = {MAX_TELEMETRY_ID_BYTES};\nexport const MAX_TELEMETRY_TIMESTAMP_MS = {MAX_TELEMETRY_TIMESTAMP_MS};\nexport const MAX_SAFE_COUNTER = {MAX_SAFE_COUNTER};\n",
        TelemetryKind::decl(), TelemetryEventKind::decl(), TelemetryEvent::decl(), TelemetryMessage::decl(),
    )
}
