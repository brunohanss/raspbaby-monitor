//! Detection is deferred until the media feasibility gate passes.
//!
//! This crate does not process frames or audio and does not emit alerts.
//! Add low-resolution motion analysis and audio activity tests in Phase 3.
//! Never use missing alerts as proof of safety.

#![forbid(unsafe_code)]
