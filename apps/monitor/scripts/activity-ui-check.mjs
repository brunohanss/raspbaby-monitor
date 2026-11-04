import assert from "node:assert/strict";
import { chromium } from "playwright";
// Test fixtures travel over a real local RTC data channel. No Pi or camera is used.
// Supply local test audio. Local validation uses the user's imported clip;
// CI generates an original tone. No clip is bundled with the application.
const clip = process.env.RASPBABY_ALERT_CLIP;
if (!clip)
  throw new Error("Set RASPBABY_ALERT_CLIP to a supported local audio file.");
const testUrl = process.env.RASPBABY_TEST_URL ?? "http://127.0.0.1:1421";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    timezoneId: "Europe/Paris",
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__alertStarts = [];
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__alertStarts.push({
        muted: document.querySelector("video")?.muted,
      });
      return original.apply(this, args);
    };
  });
  await page.goto(testUrl);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Import alert sound").setInputFiles(clip);
  await page.getByText(/^Selected: /).waitFor();
  assert.equal(
    await page
      .getByRole("switch", { name: "Enable activity alerts" })
      .getAttribute("aria-checked"),
    "true",
  );
  await page
    .getByRole("button", { name: "Allow alert sounds", exact: true })
    .click();
  await page.locator("summary").click();
  await page.getByRole("button", { name: "Create offer", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#offer").value.length > 0,
  );
  const answer = await page.evaluate(async () => {
    const offer = JSON.parse(document.querySelector("#offer").value);
    const peer = new RTCPeerConnection({ iceServers: [] });
    window.__fixturePeer = peer;
    peer.ondatachannel = (event) => {
      window.__fixtureChannel = event.channel;
    };
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const ctx = canvas.getContext("2d");
    let color = 0;
    window.__fixtureTimer = setInterval(() => {
      ctx.fillStyle = `rgb(${color++ % 255},20,30)`;
      ctx.fillRect(0, 0, 160, 120);
    }, 100);
    const track = canvas.captureStream(10).getVideoTracks()[0];
    await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    const video = peer
      .getTransceivers()
      .find((t) => t.receiver.track.kind === "video");
    await video.sender.replaceTrack(track);
    video.direction = "sendonly";
    await peer.setLocalDescription(await peer.createAnswer());
    if (peer.iceGatheringState !== "complete")
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("ICE timeout")), 5000);
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === "complete") {
            clearTimeout(timer);
            resolve();
          }
        };
      });
    return JSON.stringify({
      ...offer,
      type: "webrtc.answer",
      sdp: peer.localDescription.sdp,
    });
  });
  await page.locator("#answer").fill(answer);
  await page.getByRole("button", { name: "Apply answer", exact: true }).click();
  await page.waitForFunction(
    () => window.__fixtureChannel?.readyState === "open",
  );
  await page.waitForFunction(() => document.querySelector(".is-receiving"));
  await page.evaluate(() => {
    const now = Date.now();
    window.__fixtureMotion = { id: "m1", kind: "motion", timestamp_ms: now };
    window.__fixtureSequence = 1;
    window.__fixtureSend = (events, active = { motion: false, sound: false }) =>
      window.__fixtureChannel.send(
        JSON.stringify({
          protocol_version: 1,
          type: "monitor.telemetry",
          device_id: "browser-fixture",
          sequence: window.__fixtureSequence++,
          timestamp_ms: Date.now(),
          temperature_c: 48.5,
          audio_level: 0.7,
          motion_active: active.motion,
          sound_active: active.sound,
          dropped_events: 0,
          events,
        }),
      );
    window.__fixtureSend([window.__fixtureMotion], {
      motion: true,
      sound: false,
    });
  });
  await page.waitForFunction(() => window.__alertStarts.length === 1);
  assert.equal(await page.evaluate(() => window.__alertStarts[0].muted), true);
  assert.ok(await page.getByText("48.5", { exact: false }).first().isVisible());
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await page
    .getByRole("heading", { name: "Movement detected", exact: true })
    .waitFor();
  await page.evaluate(() =>
    window.__fixtureSend([window.__fixtureMotion], {
      motion: true,
      sound: false,
    }),
  );
  await page.waitForTimeout(5300);
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("raspbaby:activity:v1")).events.length,
    ),
    1,
  );
  assert.equal(await page.evaluate(() => window.__alertStarts.length), 1);
  await page.evaluate(() =>
    window.__fixtureSend(
      [{ id: "s1", kind: "sound", timestamp_ms: Date.now() }],
      { motion: false, sound: true },
    ),
  );
  await page.waitForFunction(() => window.__alertStarts.length === 2);
  assert.equal(await page.evaluate(() => window.__alertStarts[1].muted), true);
  await page.waitForTimeout(5300);
  await page.evaluate(() =>
    window.__fixtureSend([], { motion: false, sound: true }),
  );
  await page.waitForFunction(() => window.__alertStarts.length === 3);
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("raspbaby:activity:v1")).events.length,
    ),
    2,
    "Repeating sounds must not create activity history events",
  );
  await page.waitForTimeout(5300);
  await page.evaluate(() => window.__fixtureSend([]));
  assert.equal(
    await page.evaluate(() => window.__alertStarts.length),
    3,
    "Quiet telemetry must stop repeats",
  );
  const nightKey = await page.evaluate(() => {
    const night = new Date();
    night.setDate(night.getDate() - 1);
    night.setHours(20, 0, 0, 0);
    window.__fixtureSend([
      { id: "old-motion", kind: "motion", timestamp_ms: night.getTime() },
      { id: "old-sound", kind: "sound", timestamp_ms: night.getTime() + 1000 },
    ]);
    return `${night.getFullYear()}-${String(night.getMonth() + 1).padStart(2, "0")}-${String(night.getDate()).padStart(2, "0")}`;
  });
  await page.getByRole("button", { name: "Statistics", exact: true }).click();
  await page
    .getByRole("heading", { name: "Statistics", exact: true })
    .waitFor();
  await page.getByLabel("Night starting", { exact: true }).fill(nightKey);
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".activity-totals strong")[0]?.textContent ===
        "1" &&
      document.querySelectorAll(".activity-totals strong")[1]?.textContent ===
        "1",
  );
  assert.equal(await page.evaluate(() => window.__alertStarts.length), 3);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.reload();
  await page.getByRole("button", { name: "Events", exact: true }).click();
  assert.equal(await page.locator(".event-row").count(), 4);
  await page.getByRole("button", { name: "Statistics", exact: true }).click();
  await page.getByLabel("Night starting", { exact: true }).fill(nightKey);
  assert.deepEqual(
    await page.locator(".activity-totals strong").allTextContents(),
    ["1", "1"],
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real local RTC data-channel telemetry updates CPU/motion/sound; dedup persists; imported alert audio starts for motion OR sound while camera muted, repeats after 5 seconds without inventing history, and stops repeating when quiet; historical events count without alerts; night graph/history persist; mobile has no overflow.",
  );
} finally {
  await browser.close();
}
