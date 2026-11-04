use raspbaby_protocol::*;

fn message() -> TelemetryMessage {
    TelemetryMessage {
        protocol_version: 1,
        kind: TelemetryKind::MonitorTelemetry,
        device_id: "pi-3".into(),
        sequence: 12,
        timestamp_ms: 1_800_000_000_000,
        temperature_c: Some(52.5),
        audio_level: Some(0.02),
        motion_active: true,
        sound_active: false,
        dropped_events: 0,
        events: vec![TelemetryEvent {
            id: "pi-3-motion-1".into(),
            kind: TelemetryEventKind::Motion,
            timestamp_ms: 1_799_999_999_800,
        }],
    }
}

#[test]
fn telemetry_round_trip_keeps_typed_measurements_and_safe_defaults() {
    let message = message();
    assert_eq!(
        parse_telemetry(&serde_json::to_string(&message).unwrap()),
        Ok(message.clone())
    );
    let mut value = serde_json::to_value(&message).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("temperature_c");
    object.remove("audio_level");
    object.remove("dropped_events");
    object.remove("sound_active");
    object.insert("future_optional".into(), true.into());
    let parsed = parse_telemetry(&value.to_string()).unwrap();
    assert_eq!(parsed.temperature_c, None);
    assert_eq!(parsed.audio_level, None);
    assert_eq!(parsed.dropped_events, 0);
    assert!(!parsed.sound_active);
}

#[test]
fn rejects_unsupported_versions_types_malformed_fields_and_oversized_input() {
    assert_eq!(
        parse_telemetry(&" ".repeat(MAX_TELEMETRY_BYTES + 1)),
        Err(TelemetryError::MessageTooLarge)
    );
    for raw in ["null", "[]", "{}", "{", "{\"type\":\"webrtc.answer\"}"] {
        assert!(parse_telemetry(raw).is_err());
    }
    let original = serde_json::to_value(message()).unwrap();
    for (field, value) in [
        ("protocol_version", serde_json::json!(2)),
        ("type", serde_json::json!("device.status")),
        ("device_id", serde_json::json!("bad id")),
        ("sequence", serde_json::json!(-1)),
        ("sequence", serde_json::json!(MAX_SAFE_COUNTER + 1)),
        (
            "timestamp_ms",
            serde_json::json!(MAX_TELEMETRY_TIMESTAMP_MS + 1),
        ),
        ("temperature_c", serde_json::json!(126)),
        ("audio_level", serde_json::json!(1.1)),
        ("motion_active", serde_json::json!(1)),
        ("dropped_events", serde_json::json!(null)),
        (
            "events",
            serde_json::json!([{"id":"x","kind":"cry","timestamp_ms":0}]),
        ),
    ] {
        let mut value_with_bad_field = original.clone();
        value_with_bad_field[field] = value;
        assert!(
            parse_telemetry(&value_with_bad_field.to_string()).is_err(),
            "accepted invalid {field}"
        );
    }
}

#[test]
fn rejects_nonfinite_values_duplicate_ids_and_future_events() {
    let mut value = message();
    value.temperature_c = Some(f32::NAN);
    assert!(value.validate().is_err());
    value.temperature_c = None;
    value.audio_level = Some(f32::INFINITY);
    assert!(value.validate().is_err());
    value.audio_level = None;
    value.events.push(value.events[0].clone());
    assert!(value.validate().is_err());
    value.events.pop();
    value.events[0].timestamp_ms = value.timestamp_ms + 1;
    assert!(value.validate().is_err());
}

#[test]
fn maximum_bounded_event_batch_fits_the_wire_budget() {
    let mut value = message();
    value.device_id = "d".repeat(64);
    value.events = (0..MAX_TELEMETRY_EVENTS)
        .map(|index| TelemetryEvent {
            id: format!("{index:064}"),
            kind: TelemetryEventKind::Sound,
            timestamp_ms: value.timestamp_ms,
        })
        .collect();
    assert!(value.validate().is_ok());
    let raw = serde_json::to_string(&value).unwrap();
    assert!(raw.len() < MAX_TELEMETRY_BYTES);
    assert!(parse_telemetry(&raw).is_ok());
    value.events.push(TelemetryEvent {
        id: "overflow".into(),
        kind: TelemetryEventKind::Sound,
        timestamp_ms: value.timestamp_ms,
    });
    assert!(value.validate().is_err());
}
