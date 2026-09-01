const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream"] });
  const context = await browser.newContext();
  await context.grantPermissions(["microphone"], { origin: "http://127.0.0.1:46120" });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:46120/", { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    stream.getTracks().forEach((track) => track.stop());
    const outputs = devices.filter((device) => device.kind === "audiooutput").map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      groupId: device.groupId,
    }));
    const cable = outputs.find((device) => /CABLE Input|VB-Audio Virtual Cable/i.test(device.label));
    const probe = document.createElement("audio");
    let sinkResult = "not-attempted";
    if (cable && typeof probe.setSinkId === "function") {
      try {
        await probe.setSinkId(cable.deviceId);
        sinkResult = probe.sinkId;
      } catch (error) {
        sinkResult = `${error.name}: ${error.message}`;
      }
    }
    return { outputs, cable, hasSetSinkId: typeof probe.setSinkId === "function", sinkResult };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
