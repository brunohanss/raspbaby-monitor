use crate::{check_time, timing_valid, ActivityGate, DetectionError};

#[derive(Debug, Clone)]
pub struct AudioConfig {
    pub sample_rate: u32,
    pub window_ms: u32,
    pub min_activity_level: f32,
    pub noise_ratio: f32,
    pub noise_margin: f32,
    pub floor_smoothing: f32,
    pub confirm_ms: u64,
    pub end_ms: u64,
    pub cooldown_ms: u64,
    pub max_gap_ms: u64,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            sample_rate: 48_000,
            window_ms: 100,
            min_activity_level: 0.025,
            noise_ratio: 2.0,
            noise_margin: 0.005,
            floor_smoothing: 0.05,
            confirm_ms: 300,
            end_ms: 300,
            cooldown_ms: 0,
            max_gap_ms: 1000,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AudioReading {
    pub active: bool,
    pub level: f32,
    pub noise_floor: f32,
    pub event: bool,
}

pub struct AudioDetector {
    config: AudioConfig,
    samples_per_window: usize,
    noise_floor: f32,
    last_ms: Option<u64>,
    candidate_gap_since: Option<u64>,
    gate: ActivityGate,
}

impl AudioDetector {
    pub fn new(config: AudioConfig) -> Result<Self, DetectionError> {
        let scalars = [
            config.min_activity_level,
            config.noise_margin,
            config.floor_smoothing,
        ];
        if !(8000..=96_000).contains(&config.sample_rate)
            || !(20..=500).contains(&config.window_ms)
            || !(config.sample_rate * config.window_ms).is_multiple_of(1000)
            || scalars
                .iter()
                .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
            || config.floor_smoothing == 0.0
            || config.min_activity_level == 0.0
            || !config.noise_ratio.is_finite()
            || !(1.1..=10.0).contains(&config.noise_ratio)
            || !timing_valid(
                config.confirm_ms,
                config.end_ms,
                config.cooldown_ms,
                config.max_gap_ms,
            )
        {
            return Err(DetectionError::InvalidConfig);
        }
        let samples_per_window = (config.sample_rate * config.window_ms / 1000) as usize;
        let gate = ActivityGate::new(config.confirm_ms, config.end_ms, config.cooldown_ms);
        Ok(Self {
            config,
            samples_per_window,
            noise_floor: 0.005,
            last_ms: None,
            candidate_gap_since: None,
            gate,
        })
    }

    /// Accept one exact analysis window of normalized mono samples [-1, 1].
    /// At the defaults, pass 4800 samples and use monotonic elapsed milliseconds.
    /// Elevated windows do not teach the noise floor to ignore ongoing sound.
    pub fn update(&mut self, samples: &[f32], now_ms: u64) -> Result<AudioReading, DetectionError> {
        if samples.len() != self.samples_per_window
            || samples
                .iter()
                .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
        {
            return Err(DetectionError::InvalidInput);
        }
        check_time(self.last_ms, now_ms)?;
        if self
            .last_ms
            .is_some_and(|previous| now_ms - previous > self.config.max_gap_ms)
        {
            self.gate.interrupt(now_ms);
            self.candidate_gap_since = None;
        }
        let first_window = self.last_ms.is_none();
        self.last_ms = Some(now_ms);
        let sum: f64 = samples
            .iter()
            .map(|sample| f64::from(*sample).powi(2))
            .sum();
        let level = (sum / samples.len() as f64).sqrt() as f32;
        // The measured quiet Pi microphone can start around RMS 0.031. Learn
        // that first baseline, but cap it so startup speech is not ignored.
        if first_window {
            self.noise_floor = level.clamp(0.005, 0.05);
        }
        let threshold = self
            .config
            .min_activity_level
            .max(self.noise_floor * self.config.noise_ratio + self.config.noise_margin);
        let elevated = level >= threshold;
        if !elevated {
            self.noise_floor += self.config.floor_smoothing * (level - self.noise_floor);
        }
        // Preserve an unconfirmed sound candidate across at most 200 ms of
        // quiet speech gaps. Never confirm activity on a quiet window itself.
        let event = if !elevated && !self.gate.active && self.gate.candidate_since.is_some() {
            let gap = *self.candidate_gap_since.get_or_insert(now_ms);
            if now_ms.saturating_sub(gap) >= 200 {
                self.candidate_gap_since = None;
                self.gate.update(false, now_ms)
            } else {
                false
            }
        } else {
            if elevated
                && self
                    .candidate_gap_since
                    .is_some_and(|gap| now_ms.saturating_sub(gap) > 200)
            {
                self.gate.update(false, now_ms);
            }
            self.candidate_gap_since = None;
            self.gate.update(elevated, now_ms)
        };
        Ok(AudioReading {
            active: self.gate.active,
            level,
            noise_floor: self.noise_floor,
            event,
        })
    }
}
