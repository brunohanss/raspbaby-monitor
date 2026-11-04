use crate::{check_time, timing_valid, ActivityGate, DetectionError};

pub const ANALYSIS_WIDTH: usize = 320;
pub const ANALYSIS_HEIGHT: usize = 180;
pub const ANALYSIS_FPS: u32 = 5;

#[derive(Debug, Clone, Copy)]
pub struct DetectionRegion {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl Default for DetectionRegion {
    fn default() -> Self {
        Self {
            left: 0.0,
            top: 0.0,
            right: 1.0,
            bottom: 1.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MotionConfig {
    pub width: usize,
    pub height: usize,
    pub region: DetectionRegion,
    pub sensitivity: u8,
    pub smoothing: f32,
    pub confirm_ms: u64,
    pub end_ms: u64,
    pub cooldown_ms: u64,
    pub max_gap_ms: u64,
}

impl Default for MotionConfig {
    fn default() -> Self {
        Self {
            width: ANALYSIS_WIDTH,
            height: ANALYSIS_HEIGHT,
            region: DetectionRegion::default(),
            sensitivity: 50,
            smoothing: 0.5,
            confirm_ms: 600,
            end_ms: 2000,
            cooldown_ms: 0,
            max_gap_ms: 1000,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MotionReading {
    pub active: bool,
    pub score: f32,
    pub event: bool,
}

pub struct MotionDetector {
    config: MotionConfig,
    bounds: (usize, usize, usize, usize),
    previous: Vec<u8>,
    blurred: Vec<u8>,
    has_reference: bool,
    last_ms: Option<u64>,
    score: f32,
    gate: ActivityGate,
}

impl MotionDetector {
    pub fn new(config: MotionConfig) -> Result<Self, DetectionError> {
        let region = config.region;
        let coordinates = [region.left, region.top, region.right, region.bottom];
        if config.width < 3
            || config.height < 3
            || config.width > 640
            || config.height > 480
            || config.sensitivity > 100
            || !config.smoothing.is_finite()
            || !(0.0..=1.0).contains(&config.smoothing)
            || config.smoothing == 0.0
            || coordinates
                .iter()
                .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
            || region.left >= region.right
            || region.top >= region.bottom
            || !timing_valid(
                config.confirm_ms,
                config.end_ms,
                config.cooldown_ms,
                config.max_gap_ms,
            )
        {
            return Err(DetectionError::InvalidConfig);
        }
        let bounds = (
            (region.left * config.width as f32).floor() as usize,
            (region.top * config.height as f32).floor() as usize,
            (region.right * config.width as f32).ceil() as usize,
            (region.bottom * config.height as f32).ceil() as usize,
        );
        let length = config.width * config.height;
        let gate = ActivityGate::new(config.confirm_ms, config.end_ms, config.cooldown_ms);
        Ok(Self {
            config,
            bounds,
            previous: vec![0; length],
            blurred: vec![0; length],
            has_reference: false,
            last_ms: None,
            score: 0.0,
            gate,
        })
    }

    /// Accept one packed GRAY8 frame. Use monotonic elapsed milliseconds.
    /// Sensitivity 0..100 maps pixel threshold 33..3 and area 12%..1%.
    /// Gaussian blur and signed mean compensation suppress noise and uniform
    /// exposure changes. A change across most of the view can also be suppressed.
    pub fn update(&mut self, frame: &[u8], now_ms: u64) -> Result<MotionReading, DetectionError> {
        if frame.len() != self.previous.len() {
            return Err(DetectionError::InvalidInput);
        }
        check_time(self.last_ms, now_ms)?;
        if self
            .last_ms
            .is_some_and(|previous| now_ms - previous > self.config.max_gap_ms)
        {
            self.has_reference = false;
            self.score = 0.0;
            self.gate.interrupt(now_ms);
        }
        self.last_ms = Some(now_ms);
        blur(
            frame,
            &mut self.blurred,
            self.config.width,
            self.config.height,
        );
        let (left, top, right, bottom) = self.bounds;
        let count = (right - left) * (bottom - top);
        let mut total = 0_i64;
        if self.has_reference {
            let mut differences = [0_usize; 511];
            for y in top..bottom {
                for x in left..right {
                    let index = y * self.config.width + x;
                    let difference =
                        i16::from(self.blurred[index]) - i16::from(self.previous[index]);
                    total += i64::from(difference);
                    differences[(difference + 255) as usize] += 1;
                }
            }
            let mean = total as f32 / count as f32;
            // Median compensation keeps a moving object from shifting the
            // reference for the unchanged background.
            let mut accumulated = 0;
            let middle = count.div_ceil(2);
            let offset = differences
                .iter()
                .position(|frequency| {
                    accumulated += frequency;
                    accumulated >= middle
                })
                .unwrap_or(255) as f32
                - 255.0;
            let pixel_threshold = 33.0 - f32::from(self.config.sensitivity) * 0.30;
            let mut changed = 0_usize;
            let mut same_direction = 0_usize;
            for y in top..bottom {
                for x in left..right {
                    let index = y * self.config.width + x;
                    let difference =
                        f32::from(self.blurred[index]) - f32::from(self.previous[index]);
                    changed += usize::from((difference - offset).abs() >= pixel_threshold);
                    same_direction += usize::from(
                        difference.abs() >= pixel_threshold && difference.signum() == mean.signum(),
                    );
                }
            }
            let global_exposure =
                mean.abs() >= 12.0 && same_direction as f32 / count as f32 >= 0.85;
            if global_exposure {
                self.score = 0.0;
            } else {
                let raw_score = changed as f32 / count as f32;
                self.score += self.config.smoothing * (raw_score - self.score);
            }
        }
        std::mem::swap(&mut self.previous, &mut self.blurred);
        self.has_reference = true;
        let area_threshold = 0.12 - f32::from(self.config.sensitivity) * 0.0011;
        let event = self.gate.update(self.score >= area_threshold, now_ms);
        Ok(MotionReading {
            active: self.gate.active,
            score: self.score,
            event,
        })
    }
}

/// A 3x3 Gaussian kernel with edge replication. Accumulators cannot exceed 4080.
fn blur(frame: &[u8], output: &mut [u8], width: usize, height: usize) {
    let weights = [1_u16, 2, 1];
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0_u16;
            for (dy, weight_y) in weights.iter().enumerate() {
                let row = (y + dy).saturating_sub(1).min(height - 1);
                for (dx, weight_x) in weights.iter().enumerate() {
                    let column = (x + dx).saturating_sub(1).min(width - 1);
                    sum += u16::from(frame[row * width + column]) * weight_y * weight_x;
                }
            }
            output[y * width + x] = ((sum + 8) / 16) as u8;
        }
    }
}
