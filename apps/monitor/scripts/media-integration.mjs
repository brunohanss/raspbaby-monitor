// Run against a Vite server: RASPBABY_SPIKE_BIN points to the built native daemon.
// Chromium evidence does not establish Windows WebView2 or Android compatibility.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

const binary = process.env.RASPBABY_SPIKE_BIN;
if (!binary)
  throw new Error("Set RASPBABY_SPIKE_BIN to the native daemon executable.");
const cdpUrl = process.env.RASPBABY_CDP_URL;
const browser = cdpUrl
  ? await chromium.connectOverCDP(cdpUrl)
  : await chromium.launch({
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
const child = spawn(binary, ["--stdio-spike"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = createInterface({ input: child.stdout });
let diagnostics = "";
child.stderr.on("data", (data) => {
  diagnostics = (diagnostics + data.toString()).slice(-16000);
});
try {
  const page = cdpUrl
    ? browser.contexts()[0]?.pages()[0]
    : await browser.newPage();
  if (!page) throw new Error("No native WebView page is available.");
  if (!cdpUrl)
    await page.goto(process.env.RASPBABY_TEST_URL ?? "http://127.0.0.1:1420");
  await page.evaluate(() => {
    const Native = window.RTCPeerConnection;
    window.__peers = [];
    window.RTCPeerConnection = class extends Native {
      constructor(config) {
        super(config);
        window.__peers.push(this);
      }
    };
  });
  await page.getByRole("button", { name: "Create offer", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#offer")?.value.length > 0,
  );
  const offer = await page.locator("#offer").inputValue();
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No daemon answer within 30 seconds.")),
      30000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Daemon exited ${code}: ${diagnostics}`));
    });
    lines.on("line", (line) => {
      try {
        if (JSON.parse(line).type === "webrtc.answer") {
          clearTimeout(timer);
          resolve(line);
        }
      } catch {
        /* Non-signaling output cannot establish a media session. */
      }
    });
  });
  child.stdin.write(offer + "\n");
  const answerLine = await answer;
  if (process.env.RASPBABY_DEBUG_NEGOTIATION) {
    console.log(
      JSON.parse(answerLine)
        .sdp.split(/\r?\n/)
        .filter((line) =>
          /^(m=|a=(mid:|rtcp-mux|rtpmap:|fmtp:|inactive|sendonly|recvonly))/.test(
            line,
          ),
        )
        .join("\n"),
    );
  }
  await page.locator("#answer").fill(answerLine);
  await page.getByRole("button", { name: "Apply answer", exact: true }).click();
  const deadline = Date.now() + 30000;
  let received = false;
  let lastInbound = [];
  while (Date.now() < deadline && !received) {
    const sample = await page.evaluate(async () => {
      const peer = window.__peers.at(-1);
      const inbound = [];
      (await peer.getStats()).forEach((report) => {
        if (report.type !== "inbound-rtp") return;
        inbound.push({
          kind: report.kind,
          framesDecoded: report.framesDecoded,
          bytesReceived: report.bytesReceived,
          packetsLost: report.packetsLost,
        });
      });
      return { inbound, connection: peer.connectionState };
    });
    if (sample.inbound.length) lastInbound = sample.inbound;
    received =
      sample.inbound.some(
        (report) => report.kind === "video" && report.framesDecoded > 10,
      ) &&
      sample.inbound.some(
        (report) => report.kind === "audio" && report.bytesReceived > 0,
      );
    if (sample.connection === "closed") break;
    if (!received) {
      const errors = await page.getByRole("alert").allTextContents();
      if (errors.some((message) => message.includes("setRemoteDescription")))
        throw new Error(errors.join("\n"));
      await delay(250);
    }
  }
  if (!received) {
    console.log("Last inbound counters:", JSON.stringify(lastInbound));
    console.log(
      "Receiver diagnostics:",
      await page.evaluate(async () => {
        const peer = window.__peers.at(-1);
        const inbound = [];
        (await peer.getStats()).forEach((report) => {
          if (report.type === "inbound-rtp")
            inbound.push({
              kind: report.kind,
              framesDecoded: report.framesDecoded,
              bytesReceived: report.bytesReceived,
            });
        });
        return {
          connection: peer.connectionState,
          inbound,
          status: document.querySelector('[role="status"]')?.textContent,
        };
      }),
    );
  }
  assert.ok(received, "Decoded video and audio must arrive within 30 seconds");
  const stats = await page.evaluate(async () => {
    const result = [];
    (await window.__peers.at(-1).getStats()).forEach((report) => {
      if (report.type === "inbound-rtp")
        result.push({
          kind: report.kind,
          framesDecoded: report.framesDecoded,
          bytesReceived: report.bytesReceived,
          packetsLost: report.packetsLost,
        });
    });
    return result;
  });
  assert.ok(
    stats.some(
      (report) => report.kind === "video" && report.framesDecoded > 10,
    ),
    "Final sample must contain decoded video",
  );
  assert.ok(
    stats.some((report) => report.kind === "audio" && report.bytesReceived > 0),
    "Final sample must contain received audio",
  );
  await page
    .getByText("Receiving decoded video", { exact: false })
    .waitFor({ timeout: 5000 });
  console.log(
    JSON.stringify(
      {
        runtime: cdpUrl ? "Windows Tauri WebView2" : "Playwright Chromium",
        stats,
      },
      null,
      2,
    ),
  );
  // An abrupt sender exit must remove the old frame.
  child.kill();
  await page.waitForFunction(
    () => document.querySelector("video")?.srcObject === null,
    null,
    { timeout: 15000 },
  );
  console.log(
    "PASS: native H264/Opus received; sender exit cleared the video.",
  );
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  lines.close();
  child.stdin.end();
  child.kill();
  await browser.close();
}
