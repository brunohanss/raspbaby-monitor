# Motion and sound activity analysis

This crate processes analysis buffers on the Pi. It does not open devices,
record media, send events, or recognize crying. Missing activity does not prove
safety. The caller must report missing sources and connection loss separately.

Create `MotionDetector::new(MotionConfig::default())` and call
`update(&gray_frame, elapsed_ms)` at 5 FPS. The default frame is packed GRAY8,
320 × 180 pixels. Pass one monotonic elapsed timestamp in milliseconds. Do not
pass Unix time to one detector and elapsed time to another call on that detector.

The motion detector applies a 3 × 3 Gaussian blur, compares consecutive frames,
and compensates for uniform brightness changes with the median signed change.
It suppresses probable exposure changes when at least 85% of pixels change in
the same direction and the mean change is at least 12 grayscale units. This can
also suppress movement across most of the view. It is not baby-specific detection.

Sensitivity 0 to 100 maps linearly to a pixel threshold from 33 to 3 and a changed
area threshold from 12% to 1%. The default sensitivity is 50. The detector smooths
the changed fraction with an EMA, default weight 0.5. Region coordinates are
normalized left, top, right, and bottom values. The default region is the whole
frame. Blur uses neighboring pixels, so changes immediately outside a region
edge can affect that edge.

Motion must persist for 600 ms to become active. It must remain below threshold
for 2 seconds to end. The default event cooldown is zero: each new confirmed
episode counts once, including episodes less than 30 seconds apart. A caller
can configure a detector cooldown if needed. That optional cooldown begins
when confirmed activity ends; the active flag can still become true during it.

Create `AudioDetector::new(AudioConfig::default())` and call
`update(&mono_samples, elapsed_ms)` once per 100 ms window. At 48 kHz, each window
contains exactly 4,800 finite normalized samples in [-1, 1]. The caller must
accumulate arbitrary capture buffers into complete windows. Convert S16LE
samples to floats by dividing each signed sample by 32,768.

Sound level is linear RMS, from 0 to 1. The first window seeds the noise floor,
clamped to 0.005 to 0.05. This lets an initial quiet RMS near 0.031 establish a
baseline. Quiet windows then update the adaptive floor with EMA weight 0.05.
Elevated windows do not teach the detector to ignore ongoing activity. The
threshold is the greater of 0.025 and twice the noise floor plus 0.005. This is
an activity heuristic. A loud constant noise present from startup can still be
reported as sound activity.

Sound confirmation is 300 ms. An unconfirmed candidate can bridge quiet speech
pauses of up to 200 ms, but a quiet window never confirms activity. Longer
pauses reset the candidate. Confirmed activity ends after 300 ms below threshold.
The default sound event cooldown is zero, so each new confirmed episode counts.
These events mean sound activity, not confirmed crying.

Event counting is separate from notification timing. A client can repeat an
alert while motion **or** sound is active and apply its own configurable alert
interval. Do not count those repeated alerts as new detector events. The server
event stream reports onsets; telemetry reports the current states separately.

Both detectors reject invalid configuration, invalid buffers, and timestamps
that move backwards. A source gap longer than 1 second resets the active state
and candidate interval. Motion also discards its old reference frame. An active
state interrupted by a gap enters cooldown. Configuration exposes the timing,
threshold, and smoothing values. Frame allocation is bounded to 640 × 480;
normal integration must use the lower default analysis resolution.

Run `cargo test --locked -p raspbaby-detection`. Deterministic synthetic tests
cover confirmation, end delay, cooldown, noise, uniform brightness, region
exclusion, RMS, adaptive noise floor, source gaps, and invalid input. They do not
establish false-positive rates or reliable behavior on every camera or microphone.
