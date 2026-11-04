use raspbaby_detection::*;

fn motion() -> MotionDetector {
    MotionDetector::new(MotionConfig {
        width: 16,
        height: 16,
        ..MotionConfig::default()
    })
    .unwrap()
}

fn picture(moved: bool) -> Vec<u8> {
    let mut frame = vec![50; 256];
    let start = if moved { 9 } else { 3 };
    for y in 4..12 {
        for x in start..start + 4 {
            frame[y * 16 + x] = 200;
        }
    }
    frame
}

#[test]
fn static_noise_and_uniform_exposure_do_not_emit_motion() {
    let mut detector = motion();
    for tick in 0..100 {
        let frame: Vec<u8> = (0..256)
            .map(|pixel| 128 + ((pixel * 17 + tick * 13) % 5) as u8)
            .collect();
        let reading = detector.update(&frame, tick * 200).unwrap();
        assert!(!reading.event && !reading.active);
    }
    for (index, value) in [80, 140, 200, 199, 180, 100, 95].into_iter().enumerate() {
        let reading = detector
            .update(&vec![value; 256], 20_000 + index as u64 * 200)
            .unwrap();
        assert!(!reading.event && !reading.active);
        assert!(reading.score < 0.01);
    }
}

#[test]
fn motion_confirms_then_ends_and_cooldown_suppresses_repeat_events() {
    let mut detector = MotionDetector::new(MotionConfig {
        width: 16,
        height: 16,
        cooldown_ms: 30_000,
        ..MotionConfig::default()
    })
    .unwrap();
    detector.update(&picture(false), 0).unwrap();
    let mut events = Vec::new();
    for tick in 1..=8 {
        let reading = detector
            .update(&picture(tick % 2 == 1), tick * 200)
            .unwrap();
        if reading.event {
            events.push(tick * 200);
        }
    }
    assert_eq!(events, vec![800]);
    for tick in 9..=30 {
        detector.update(&picture(false), tick * 200).unwrap();
    }
    assert!(!detector.update(&picture(false), 6200).unwrap().active);
    let mut active_during_cooldown = false;
    for tick in 32..=40 {
        let reading = detector
            .update(&picture(tick % 2 == 1), tick * 200)
            .unwrap();
        assert!(!reading.event);
        active_during_cooldown |= reading.active;
    }
    assert!(active_during_cooldown);
    for tick in 41..=210 {
        detector.update(&picture(false), tick * 200).unwrap();
    }
    let mut after_cooldown = 0;
    for tick in 211..=220 {
        after_cooldown += usize::from(
            detector
                .update(&picture(tick % 2 == 1), tick * 200)
                .unwrap()
                .event,
        );
    }
    assert_eq!(after_cooldown, 1);
}

#[test]
fn region_excludes_outside_movement_and_gap_discards_stale_state() {
    let mut detector = MotionDetector::new(MotionConfig {
        width: 16,
        height: 16,
        region: DetectionRegion {
            right: 0.5,
            ..DetectionRegion::default()
        },
        ..MotionConfig::default()
    })
    .unwrap();
    for tick in 0..20 {
        let mut frame = vec![50; 256];
        if tick % 2 == 1 {
            for y in 4..12 {
                for x in 12..16 {
                    frame[y * 16 + x] = 220;
                }
            }
        }
        assert!(!detector.update(&frame, tick * 200).unwrap().active);
    }
    let mut detector = motion();
    for tick in 0..8 {
        detector
            .update(&picture(tick % 2 == 1), tick * 200)
            .unwrap();
    }
    let reset = detector.update(&picture(true), 5000).unwrap();
    assert!(!reset.active && !reset.event && reset.score == 0.0);
    assert_eq!(
        detector.update(&picture(false), 4000).unwrap_err(),
        DetectionError::TimeWentBackwards
    );
    assert_eq!(
        detector.update(&[0], 5200).unwrap_err(),
        DetectionError::InvalidInput
    );
}

fn samples(level: f32) -> Vec<f32> {
    (0..4800)
        .map(|i| if i % 2 == 0 { level } else { -level })
        .collect()
}

#[test]
fn audio_rms_floor_and_short_noise_are_deterministic() {
    let mut detector = AudioDetector::new(AudioConfig::default()).unwrap();
    let mut floor = 0.0;
    for tick in 0..50 {
        let level = 0.01 + tick as f32 * 0.0004;
        let reading = detector.update(&samples(level), tick * 100).unwrap();
        assert!(!reading.active && !reading.event);
        assert!((reading.level - level).abs() < 0.00001);
        floor = reading.noise_floor;
    }
    assert!(floor > 0.015 && floor < 0.03);
    assert!(!detector.update(&samples(0.3), 5000).unwrap().event);
    for tick in 51..60 {
        let reading = detector.update(&samples(0.02), tick * 100).unwrap();
        assert!(!reading.event && !reading.active);
    }
}

#[test]
fn sustained_sound_confirms_once_and_cooldown_filters_repeats() {
    let mut detector = AudioDetector::new(AudioConfig {
        confirm_ms: 600,
        cooldown_ms: 30_000,
        ..AudioConfig::default()
    })
    .unwrap();
    let mut events = Vec::new();
    for tick in 0..20 {
        let reading = detector.update(&samples(0.2), tick * 100).unwrap();
        if reading.event {
            events.push(tick * 100);
        }
    }
    assert_eq!(events, vec![600]);
    for tick in 20..30 {
        detector.update(&samples(0.0), tick * 100).unwrap();
    }
    for tick in 30..40 {
        assert!(!detector.update(&samples(0.2), tick * 100).unwrap().event);
    }
    for tick in 40..350 {
        detector.update(&samples(0.0), tick * 100).unwrap();
    }
    let mut later = 0;
    for tick in 350..360 {
        later += usize::from(detector.update(&samples(0.2), tick * 100).unwrap().event);
    }
    assert_eq!(later, 1);
    let reset = detector.update(&samples(0.2), 40_000).unwrap();
    assert!(!reset.active && !reset.event);
}

#[test]
fn default_motion_counts_distinct_episodes_without_notification_cooldown() {
    let mut detector = motion();
    let mut count = 0;
    for tick in 0..=8 {
        count += usize::from(
            detector
                .update(&picture(tick % 2 == 1), tick * 200)
                .unwrap()
                .event,
        );
    }
    for tick in 9..=30 {
        count += usize::from(detector.update(&picture(false), tick * 200).unwrap().event);
    }
    for tick in 31..=39 {
        count += usize::from(
            detector
                .update(&picture(tick % 2 == 1), tick * 200)
                .unwrap()
                .event,
        );
    }
    assert_eq!(count, 2);
}

#[test]
fn measured_quiet_baseline_and_speech_pauses_count_new_sound_episodes() {
    let mut detector = AudioDetector::new(AudioConfig::default()).unwrap();
    for tick in 0..20 {
        let reading = detector.update(&samples(0.031), tick * 100).unwrap();
        assert!(!reading.active && !reading.event);
    }
    let first_speech = [0.08, 0.113, 0.031, 0.08];
    let mut event_times = Vec::new();
    for (index, level) in first_speech.into_iter().enumerate() {
        let time = 2000 + index as u64 * 100;
        let reading = detector.update(&samples(level), time).unwrap();
        if reading.event {
            event_times.push(time);
        }
    }
    assert_eq!(event_times, vec![2300]);
    for tick in 24..=27 {
        detector.update(&samples(0.031), tick * 100).unwrap();
    }
    for (index, level) in [0.09, 0.10, 0.031, 0.10].into_iter().enumerate() {
        let time = 2800 + index as u64 * 100;
        if detector.update(&samples(level), time).unwrap().event {
            event_times.push(time);
        }
    }
    assert_eq!(event_times, vec![2300, 3100]);
}

#[test]
fn quiet_windows_never_confirm_sound_and_long_pauses_reset_candidates() {
    let mut detector = AudioDetector::new(AudioConfig::default()).unwrap();
    detector.update(&samples(0.031), 0).unwrap();
    assert!(!detector.update(&samples(0.113), 100).unwrap().event);
    for tick in 2..=10 {
        let reading = detector.update(&samples(0.031), tick * 100).unwrap();
        assert!(!reading.event && !reading.active);
    }
    assert!(!detector.update(&samples(0.113), 1100).unwrap().event);
}

#[test]
fn invalid_configuration_and_nonfinite_samples_are_rejected() {
    assert!(MotionDetector::new(MotionConfig {
        width: usize::MAX,
        ..MotionConfig::default()
    })
    .is_err());
    assert!(MotionDetector::new(MotionConfig {
        smoothing: f32::NAN,
        ..MotionConfig::default()
    })
    .is_err());
    assert!(AudioDetector::new(AudioConfig {
        sample_rate: u32::MAX,
        ..AudioConfig::default()
    })
    .is_err());
    assert!(AudioDetector::new(AudioConfig {
        floor_smoothing: f32::NAN,
        ..AudioConfig::default()
    })
    .is_err());
    let mut detector = AudioDetector::new(AudioConfig::default()).unwrap();
    assert_eq!(
        detector.update(&[0.0], 0).unwrap_err(),
        DetectionError::InvalidInput
    );
    for value in [f32::NAN, f32::INFINITY, 1.1] {
        assert_eq!(
            detector.update(&vec![value; 4800], 0).unwrap_err(),
            DetectionError::InvalidInput
        );
    }
    detector.update(&samples(0.01), 100).unwrap();
    assert_eq!(
        detector.update(&samples(0.01), 0).unwrap_err(),
        DetectionError::TimeWentBackwards
    );
}
