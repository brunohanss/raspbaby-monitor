// SDP stays in memory. This runner does not capture screenshots, video, or audio.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { chromium } from "playwright";

export function readConfig(env) {
  const duration = env.RASPBABY_DURATION_SECONDS ?? "60";
  assert.match(
    duration,
    /^\d+$/,
    "Duration must be an integer number of seconds.",
  );
  const durationSeconds = Number(duration);
  assert.ok(
    durationSeconds >= 1 && durationSeconds <= 600,
    "Duration must be 1 to 600 seconds.",
  );
  const audio = env.RASPBABY_EXPECT_AUDIO ?? "true";
  const expectedDimensions = env.RASPBABY_EXPECT_DIMENSIONS;
  assert.ok(
    !expectedDimensions || ["640x480", "1280x720"].includes(expectedDimensions),
    "Expected dimensions must be 640x480 or 1280x720.",
  );
  assert.ok(
    audio === "true" || audio === "false",
    "RASPBABY_EXPECT_AUDIO must be true or false.",
  );
  const target = env.RASPBABY_SSH_TARGET;
  if (target) {
    assert.match(
      target,
      /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/,
      "SSH target must be a user@host or hostname, without shell arguments.",
    );
    assert.ok(
      env.RASPBABY_REMOTE_COMMAND?.trim(),
      "Set RASPBABY_REMOTE_COMMAND to the explicit remote daemon command.",
    );
    assert.ok(
      !/[\r\n\0]/.test(env.RASPBABY_REMOTE_COMMAND),
      "Remote command must be one line.",
    );
    assert.ok(
      !env.RASPBABY_SPIKE_BIN,
      "Select one sender: SSH target or local binary.",
    );
  } else {
    assert.ok(
      env.RASPBABY_SPIKE_BIN,
      "Set RASPBABY_SPIKE_BIN or RASPBABY_SSH_TARGET.",
    );
    assert.ok(
      !env.RASPBABY_REMOTE_COMMAND,
      "Remote command requires an SSH target.",
    );
  }
  return {
    durationSeconds,
    expectAudio: audio === "true",
    expectedDimensions,
    target,
    command: target ? "ssh" : env.RASPBABY_SPIKE_BIN,
    args: target
      ? [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ServerAliveInterval=10",
          "-o",
          "ServerAliveCountMax=2",
          "--",
          target,
          `exec ${env.RASPBABY_REMOTE_COMMAND}`,
        ]
      : ["--stdio-spike"],
  };
}

export function checkSample(sample, expectAudio) {
  const video = sample.inbound.find((report) => report.kind === "video");
  const audio = sample.inbound.find((report) => report.kind === "audio");
  assert.ok(
    video?.framesDecoded > 10,
    "The sample must contain decoded video.",
  );
  assert.equal(
    video.codec?.toLowerCase(),
    "video/h264",
    "The received video codec must be H.264.",
  );
  if (expectAudio) {
    assert.ok(
      audio?.bytesReceived > 0,
      "The sample must contain received audio.",
    );
    assert.equal(
      audio.codec?.toLowerCase(),
      "audio/opus",
      "The received audio codec must be Opus.",
    );
    if (typeof audio.decodedAudioSamples === "number")
      assert.ok(
        audio.decodedAudioSamples > 0,
        "The audio decoder must produce samples when the runtime reports this counter.",
      );
  }
  return {
    frames: video.framesDecoded,
    videoBytes: video.bytesReceived,
    audioBytes: audio?.bytesReceived ?? 0,
  };
}

async function sampleReceiver(page) {
  return page.evaluate(async () => {
    const peer = window.__raspbabyTestPeers?.at(-1);
    if (!peer) return { connection: "missing", inbound: [], playback: false };
    const reports = await peer.getStats();
    const inbound = [];
    reports.forEach((report) => {
      if (report.type !== "inbound-rtp") return;
      const codec = reports.get(report.codecId);
      inbound.push({
        kind: report.kind ?? report.mediaType,
        framesDecoded: report.framesDecoded ?? 0,
        frameWidth: report.frameWidth ?? null,
        frameHeight: report.frameHeight ?? null,
        decodedAudioSamples:
          report.totalSamplesReceived ??
          report.jitterBufferEmittedCount ??
          null,
        totalAudioEnergy: report.totalAudioEnergy ?? null,
        bytesReceived: report.bytesReceived ?? 0,
        packetsLost: report.packetsLost ?? 0,
        codec: codec?.mimeType ?? null,
        codecParameters: codec?.sdpFmtpLine ?? null,
      });
    });
    const video = document.querySelector("video");
    return {
      connection: peer.connectionState,
      inbound,
      playback: Boolean(
        video &&
        !video.paused &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0,
      ),
      playbackDimensions: video
        ? { width: video.videoWidth, height: video.videoHeight }
        : null,
      status: document.querySelector('[role="status"]')?.textContent,
    };
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const exited = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", exited);
      reject(
        new Error(
          "Sender did not exit within 10 seconds after stdin closed; remote cleanup is not verified.",
        ),
      );
    }, timeoutMs);
    child.once("exit", exited);
  });
}

async function run() {
  const config = readConfig(process.env);
  const cdpUrl = process.env.RASPBABY_CDP_URL;
  const browser = cdpUrl
    ? await chromium.connectOverCDP(cdpUrl)
    : await chromium.launch({
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
  const child = spawn(config.command, config.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let spawnError;
  let senderStopped = false;
  let page;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdin.on("error", (error) => {
    spawnError = error;
  });
  // Do not print SDP or daemon logs, which can contain private network details.
  child.stderr.resume();
  try {
    page = cdpUrl ? browser.contexts()[0]?.pages()[0] : await browser.newPage();
    if (!page) throw new Error("No native WebView page is available.");
    if (!cdpUrl)
      await page.goto(process.env.RASPBABY_TEST_URL ?? "http://127.0.0.1:1420");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    if (
      !(await page
        .locator(".connection-settings")
        .evaluate((element) => element.open))
    ) {
      await page.locator(".connection-settings > summary").click();
    }
    await page.evaluate(() => {
      if (!window.__raspbabyNativePeer)
        window.__raspbabyNativePeer = window.RTCPeerConnection;
      const Native = window.__raspbabyNativePeer;
      window.__raspbabyTestPeers = [];
      window.RTCPeerConnection = class extends Native {
        constructor(config) {
          super(config);
          window.__raspbabyTestPeers.push(this);
        }
      };
    });
    await page
      .getByRole("button", { name: "Create offer", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector("#offer")?.value.length > 0,
    );
    if (spawnError) throw spawnError;
    if (child.exitCode !== null)
      throw new Error(
        `Sender exited before the offer (code ${child.exitCode}).`,
      );
    const offer = await page.locator("#offer").inputValue();
    const answer = new Promise((resolve, reject) => {
      const finish = (error, line) => {
        clearTimeout(timer);
        lines.removeListener("line", received);
        child.removeListener("error", failed);
        child.removeListener("exit", exited);
        if (error) reject(error);
        else resolve(line);
      };
      const failed = () =>
        finish(
          new Error(
            "Could not start the sender. Check the configured path and SSH access.",
          ),
        );
      const exited = (code) =>
        finish(new Error(`Sender exited before an answer (code ${code}).`));
      const received = (line) => {
        if (Buffer.byteLength(line) > 98304)
          return finish(
            new Error("Sender answer exceeds the protocol size limit."),
          );
        try {
          if (JSON.parse(line).type === "webrtc.answer") finish(null, line);
        } catch {
          /* Ignore non-signaling lines. */
        }
      };
      const timer = setTimeout(
        () => finish(new Error("No daemon answer within 60 seconds.")),
        60000,
      );
      child.once("error", failed);
      child.once("exit", exited);
      lines.on("line", received);
    });
    child.stdin.write(offer + "\n");
    await page.locator("#answer").fill(await answer);
    await page
      .getByRole("button", { name: "Apply answer", exact: true })
      .click();
    let sample;
    const startupDeadline = Date.now() + 30000;
    for (;;) {
      sample = await sampleReceiver(page);
      const video = sample.inbound.some(
        (report) => report.kind === "video" && report.framesDecoded > 10,
      );
      const audio =
        !config.expectAudio ||
        sample.inbound.some(
          (report) => report.kind === "audio" && report.bytesReceived > 0,
        );
      if (video && audio) break;
      assert.ok(
        !["closed", "failed", "disconnected"].includes(sample.connection),
        `Receiver stopped during startup: ${sample.connection}.`,
      );
      assert.ok(
        Date.now() < startupDeadline,
        "Expected media did not arrive within 30 seconds.",
      );
      await delay(250);
    }
    await page.getByRole("button", { name: "Play media", exact: true }).click();
    const first = checkSample(sample, config.expectAudio);
    const startedAt = Date.now();
    let lastVideoProgressAt = startedAt;
    let lastAudioProgressAt = startedAt;
    let previous = first;
    let samples = 0;
    while (Date.now() - startedAt < config.durationSeconds * 1000) {
      await delay(1000);
      if (spawnError) throw spawnError;
      assert.equal(
        child.exitCode,
        null,
        "Sender exited during the sustained test.",
      );
      sample = await sampleReceiver(page);
      assert.equal(
        sample.connection,
        "connected",
        "The media connection must remain connected.",
      );
      const counters = checkSample(sample, config.expectAudio);
      assert.ok(
        counters.frames >= previous.frames &&
          counters.audioBytes >= previous.audioBytes,
        "Received counters must not reset during a session.",
      );
      if (counters.frames > previous.frames) lastVideoProgressAt = Date.now();
      if (counters.audioBytes > previous.audioBytes)
        lastAudioProgressAt = Date.now();
      assert.ok(
        Date.now() - lastVideoProgressAt < 5000,
        "Decoded video stopped progressing for 5 seconds.",
      );
      if (config.expectAudio)
        assert.ok(
          Date.now() - lastAudioProgressAt < 5000,
          "Received audio stopped progressing for 5 seconds.",
        );
      previous = counters;
      samples++;
    }
    assert.ok(
      previous.frames > first.frames && previous.videoBytes > first.videoBytes,
      "Video must progress across the sustained test.",
    );
    if (config.expectAudio)
      assert.ok(
        previous.audioBytes > first.audioBytes,
        "Audio must progress across the sustained test.",
      );
    assert.ok(
      sample.playback,
      "The video element must be playing decoded video.",
    );
    if (config.expectedDimensions) {
      assert.equal(
        `${sample.playbackDimensions?.width}x${sample.playbackDimensions?.height}`,
        config.expectedDimensions,
        "Rendered video dimensions must match the selected preset.",
      );
    }
    await page
      .locator(".video-status")
      .getByText("Live", { exact: true })
      .waitFor({ timeout: 5000 });
    console.log(
      JSON.stringify(
        {
          runtime:
            process.env.RASPBABY_RUNTIME_LABEL ??
            (cdpUrl ? "Native Tauri WebView" : "Playwright Chromium"),
          sender: config.target ? "SSH stdio" : "Local process",
          audioExpected: config.expectAudio,
          durationSeconds: (Date.now() - startedAt) / 1000,
          samples,
          progress: {
            decodedFrames: previous.frames - first.frames,
            videoBytes: previous.videoBytes - first.videoBytes,
            audioBytes: previous.audioBytes - first.audioBytes,
          },
          stats: sample.inbound,
          playbackDimensions: sample.playbackDimensions,
        },
        null,
        2,
      ),
    );
    // SSH EOF reaches the exec'd remote daemon. Confirm its exit before killing SSH.
    // Local mode also tests abrupt sender termination.
    if (config.target) child.stdin.end();
    else child.kill();
    const exit = await waitForExit(child, 10000);
    if (config.target)
      assert.equal(
        exit.code,
        0,
        "Remote daemon must exit cleanly after SSH stdin closes.",
      );
    senderStopped = true;
    await page.waitForFunction(
      () => document.querySelector("video")?.srcObject === null,
      null,
      { timeout: 15000 },
    );
    console.log(
      `PASS: sustained H.264${config.expectAudio ? "/Opus" : " video"}; sender stopped; stale video cleared${config.target ? "; remote EOF cleanup verified" : ""}.`,
    );
  } finally {
    lines.close();
    if (!senderStopped) {
      child.stdin.end();
      try {
        await waitForExit(child, 10000);
      } catch (error) {
        child.kill();
        console.error(error.message);
      }
    }
    if (page) {
      await page
        .getByRole("button", { name: "Stop", exact: true })
        .click()
        .catch(() => {});
    }
    await browser.close();
  }
}

if (process.argv.includes("--self-test")) {
  const { test } = await import("node:test");
  test("SSH uses verified noninteractive stdio and a single explicit remote command", () => {
    const config = readConfig({
      RASPBABY_SSH_TARGET: "raspbaby@raspbaby.local",
      RASPBABY_REMOTE_COMMAND: "/opt/raspbaby/daemon --stdio-spike",
      RASPBABY_DURATION_SECONDS: "60",
    });
    assert.equal(config.command, "ssh");
    assert.ok(config.args.includes("StrictHostKeyChecking=yes"));
    assert.ok(config.args.includes("BatchMode=yes"));
    assert.equal(config.args.at(-1), "exec /opt/raspbaby/daemon --stdio-spike");
  });
  test("rejects invalid limits, ambiguous modes, and SSH argument injection", () => {
    assert.throws(() =>
      readConfig({
        RASPBABY_SPIKE_BIN: "daemon",
        RASPBABY_EXPECT_DIMENSIONS: "1920x1080",
      }),
    );
    for (const duration of ["0", "601", "NaN", "1.5"])
      assert.throws(() =>
        readConfig({
          RASPBABY_SPIKE_BIN: "daemon",
          RASPBABY_DURATION_SECONDS: duration,
        }),
      );
    assert.throws(() =>
      readConfig({
        RASPBABY_SSH_TARGET: "-oProxyCommand=bad",
        RASPBABY_REMOTE_COMMAND: "daemon",
      }),
    );
    assert.throws(() =>
      readConfig({
        RASPBABY_SSH_TARGET: "host",
        RASPBABY_REMOTE_COMMAND: "daemon",
        RASPBABY_SPIKE_BIN: "daemon",
      }),
    );
  });
  test("requires active H.264 and Opus codecs rather than offered codec names", () => {
    const video = {
      kind: "video",
      framesDecoded: 12,
      bytesReceived: 300,
      codec: "video/H264",
    };
    const audio = { kind: "audio", bytesReceived: 20, codec: "audio/opus" };
    assert.deepEqual(checkSample({ inbound: [video, audio] }, true), {
      frames: 12,
      videoBytes: 300,
      audioBytes: 20,
    });
    assert.throws(() => checkSample({ inbound: [video] }, true));
    assert.throws(() =>
      checkSample({ inbound: [{ ...video, codec: "video/VP8" }, audio] }, true),
    );
    assert.doesNotThrow(() =>
      checkSample(
        { inbound: [video, { ...audio, decodedAudioSamples: 48000 }] },
        true,
      ),
    );
    assert.throws(() =>
      checkSample(
        { inbound: [video, { ...audio, decodedAudioSamples: 0 }] },
        true,
      ),
    );
    assert.doesNotThrow(() =>
      checkSample(
        { inbound: [video, { ...audio, decodedAudioSamples: null }] },
        true,
      ),
    );
    assert.deepEqual(checkSample({ inbound: [video] }, false), {
      frames: 12,
      videoBytes: 300,
      audioBytes: 0,
    });
  });
} else {
  await run();
}
