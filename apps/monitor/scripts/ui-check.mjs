import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const output = fileURLToPath(
  new URL("../../../target/ui-review/", import.meta.url),
);
try {
  await mkdir(output, { recursive: true });
  for (const viewport of [
    { width: 1672, height: 941 },
    { width: 1440, height: 850 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.env.RASPBABY_TEST_URL ?? "http://127.0.0.1:1421");
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page
        .getByRole("heading", { name: "Raspbaby Monitor", exact: true })
        .count(),
      1,
    );
    assert.ok(
      await page
        .getByRole("button", { name: "Connect camera", exact: true })
        .isVisible(),
    );
    assert.equal(
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button")
        .count(),
      4,
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(
      overflow,
      false,
      `No horizontal overflow at ${viewport.width}px`,
    );
    await page.screenshot({
      path: `${output}/live-${viewport.width}.png`,
      fullPage: true,
    });
    const sound = page.getByRole("switch", {
      name: "Camera sound",
      exact: true,
    });
    await sound.click();
    assert.equal(await sound.getAttribute("aria-checked"), "true");
    await page.getByRole("button", { name: "Events", exact: true }).click();
    assert.ok(
      await page.getByRole("heading", { name: "No events yet" }).isVisible(),
    );
    await page.getByRole("button", { name: "Statistics", exact: true }).click();
    assert.ok(
      await page
        .getByRole("heading", { name: "Statistics", exact: true })
        .isVisible(),
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    assert.equal(
      await page
        .getByRole("switch", { name: "Enable camera sound", exact: true })
        .getAttribute("aria-checked"),
      "true",
    );
    await page.locator("summary").click();
    assert.ok(
      await page
        .getByRole("button", { name: "Create offer", exact: true })
        .isVisible(),
    );
    await page.screenshot({
      path: `${output}/settings-${viewport.width}.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  // Exercise the real offer/answer UI without requesting or sending any media.
  // A reduced viewport approximates keyboard space; it does not emulate Android IME.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  });
  const page = await mobile.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.RASPBABY_TEST_URL ?? "http://127.0.0.1:1421");
  const video = await page.locator("video").elementHandle();
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  await page.locator("summary").tap();
  await page.getByRole("button", { name: "Create offer", exact: true }).tap();
  await page.waitForFunction(
    () => document.querySelector("#offer")?.value.length > 0,
  );
  const answer = await page.evaluate(async () => {
    const offer = JSON.parse(document.querySelector("#offer").value);
    const peer = new RTCPeerConnection({ iceServers: [] });
    // Keep this peer in memory until cleanup so its answer remains valid.
    window.__uiCheckAnswerPeer = peer;
    await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    await peer.setLocalDescription(await peer.createAnswer());
    return JSON.stringify({
      ...offer,
      type: "webrtc.answer",
      sdp: peer.localDescription.sdp,
    });
  });
  await page.locator("#answer").tap();
  await page.locator("#answer").fill(answer);
  await page.setViewportSize({ width: 390, height: 365 });
  await page.getByRole("button", { name: "Apply answer", exact: true }).tap();
  await page
    .getByRole("heading", { name: "Connecting to camera", exact: true })
    .waitFor({ state: "visible", timeout: 5000 });
  assert.ok(
    await page
      .getByRole("heading", { name: "Connecting to camera", exact: true })
      .isVisible(),
    "A normal mobile tap must apply the answer and return to the live screen.",
  );
  assert.ok(
    await video.evaluate(
      (element) => element === document.querySelector("video"),
    ),
    "The video element must stay mounted across navigation.",
  );
  await page.getByRole("button", { name: "Stop", exact: true }).tap();
  await page.evaluate(() => window.__uiCheckAnswerPeer.close());
  assert.deepEqual(errors, []);
  await mobile.close();
  console.log(
    "PASS: reference-layout viewports, navigation, sound controls, normal mobile answer tap with reduced viewport, retained video element, and no runtime errors.",
  );
} finally {
  await browser.close();
}
