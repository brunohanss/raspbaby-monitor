//! Pure, bounded motion and sound activity analysis. No raw media is stored.
//! These detectors do not recognize babies or crying. Missing events do not
//! prove safety. Callers must report disconnected or missing sources separately.

#![forbid(unsafe_code)]

mod audio;
mod motion;
pub use audio::*;
pub use motion::*;

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectionError {
    InvalidConfig,
    InvalidInput,
    TimeWentBackwards,
}

impl fmt::Display for DetectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidConfig => "invalid detection configuration",
            Self::InvalidInput => "invalid detection frame or samples",
            Self::TimeWentBackwards => "detector time moved backwards",
        })
    }
}

impl std::error::Error for DetectionError {}

/// Event cooldown starts when confirmed activity ends. Activity can still be
/// visible during cooldown, but its new confirmation does not emit an event.
struct ActivityGate {
    active: bool,
    candidate_since: Option<u64>,
    quiet_since: Option<u64>,
    cooldown_until: u64,
    confirm_ms: u64,
    end_ms: u64,
    cooldown_ms: u64,
}

impl ActivityGate {
    fn new(confirm_ms: u64, end_ms: u64, cooldown_ms: u64) -> Self {
        Self {
            active: false,
            candidate_since: None,
            quiet_since: None,
            cooldown_until: 0,
            confirm_ms,
            end_ms,
            cooldown_ms,
        }
    }

    fn interrupt(&mut self, now: u64) {
        if self.active {
            self.cooldown_until = now.saturating_add(self.cooldown_ms);
        }
        self.active = false;
        self.candidate_since = None;
        self.quiet_since = None;
    }

    fn update(&mut self, elevated: bool, now: u64) -> bool {
        if elevated {
            self.quiet_since = None;
            if !self.active {
                let start = *self.candidate_since.get_or_insert(now);
                if now.saturating_sub(start) >= self.confirm_ms {
                    self.active = true;
                    self.candidate_since = None;
                    return now >= self.cooldown_until;
                }
            }
        } else {
            self.candidate_since = None;
            if self.active {
                let start = *self.quiet_since.get_or_insert(now);
                if now.saturating_sub(start) >= self.end_ms {
                    self.interrupt(now);
                }
            }
        }
        false
    }
}

fn timing_valid(confirm_ms: u64, end_ms: u64, cooldown_ms: u64, max_gap_ms: u64) -> bool {
    (1..=10_000).contains(&confirm_ms)
        && (1..=30_000).contains(&end_ms)
        && cooldown_ms <= 300_000
        && (200..=10_000).contains(&max_gap_ms)
}

fn check_time(last: Option<u64>, now: u64) -> Result<(), DetectionError> {
    if last.is_some_and(|previous| now < previous) {
        Err(DetectionError::TimeWentBackwards)
    } else {
        Ok(())
    }
}
