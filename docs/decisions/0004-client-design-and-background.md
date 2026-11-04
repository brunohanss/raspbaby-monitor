# ADR 0004: Follow the supplied monitor design and preserve active monitoring

Status: Accepted user direction, 2026-11-03. Runtime checks are in progress.

2026-11-04 addition: the user selected one exact Murloc clip for movement and
sound alerts. Prepare local import, preview, and volume settings now. Follow
the plan's local-audio rule. This narrow user request does not enable synthetic
alert events or imply that motion and sound detection are implemented.

## Decision

Use the user-supplied desktop reference as the client design. Use Tailwind,
small React components, bundled fonts, and SVG icons. Keep connection setup
out of the main monitoring view. Keep Live, Events, Statistics, and Settings
as the main navigation items. Preserve the video element across navigation.

Show Live only after fresh decoded video. Do not copy the reference photograph
into a simulated live view. Display unavailable temperature or detection data
as unavailable. A visual reference is not evidence that telemetry exists.

On Windows, closing the window hides it to the tray. Reopening must preserve
the same receiver. An explicit Quit action stops the application. Use a
single-instance handler to restore a running hidden window.

The user also requested Android background monitoring. This supersedes the
original MVP exclusion of Android background operation for this work item.
Use an explicit foreground playback service, an ongoing notification, and a
partial wake lock. Start only after media arrives. Renew its bounded lease
only while received media advances. Stop on lost media progress or explicit
notification Stop. Disabling background operation must preserve foreground
playback. Back moves the active task to the background.

## Acceptance and limits

Verify real media progress while the Windows window is hidden and while the
Android app is backgrounded or the screen is locked. Verify reopening, explicit
Stop, Quit, notification behavior, and cleanup. Do not substitute a service
status flag for media evidence. Android force-stop and playback Activity
destruction end the current WebView session; do not claim otherwise.

Record camera visual quality separately from transport statistics. The observed
MJPEG corruption keeps visual acceptance open even when frame counters advance.
