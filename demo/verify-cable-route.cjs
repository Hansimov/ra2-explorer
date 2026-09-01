const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const target = path.resolve(__dirname, "cable-route-test.wav");

async function main() {
  const capture = spawn("ffmpeg.exe", ["-hide_banner", "-loglevel", "warning", "-y", "-f", "dshow", "-i", "audio=CABLE Output (VB-Audio Virtual Cable)", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", target], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let captureError = "";
  capture.stderr.on("data", (chunk) => { captureError += chunk.toString(); });
  await new Promise((resolve) => setTimeout(resolve, 800));

  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--mute-audio"], args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext();
  await context.grantPermissions(["microphone"], { origin: "http://127.0.0.1:46120" });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:46120/", { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audiooutput");
    permissionStream.getTracks().forEach((track) => track.stop());
    const cable = outputs.find((device) => /^CABLE Input \(VB-Audio Virtual Cable\)$/i.test(device.label));
    if (!cable) throw new Error(`未找到 CABLE Input：${outputs.map((device) => device.label).join("、")}`);
    const audioContext = new AudioContext({ sampleRate: 48000 });
    const destination = audioContext.createMediaStreamDestination();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 523.25;
    gain.gain.value = 0.12;
    oscillator.connect(gain).connect(destination);
    const output = document.createElement("audio");
    output.srcObject = destination.stream;
    await output.setSinkId(cable.deviceId);
    await output.play();
    oscillator.start();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    oscillator.stop();
    await new Promise((resolve) => setTimeout(resolve, 250));
    output.pause();
    await audioContext.close();
    return { label: cable.label, sinkApplied: output.sinkId === cable.deviceId };
  });
  await browser.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  capture.stdin.write("q\n");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { capture.kill(); reject(new Error("CABLE 录音停止超时")); }, 10000);
    capture.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 255) resolve();
      else reject(new Error(`FFmpeg 退出 ${code}：${captureError}`));
    });
  });
  console.log(JSON.stringify({ ...result, target, bytes: fs.statSync(target).size }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
