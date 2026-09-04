const path = require("path");

function demoExportDirectory(startDirectory = __dirname) {
  if (process.env.RA2EXP_DEMO_EXPORT_DIR) {
    return path.resolve(process.env.RA2EXP_DEMO_EXPORT_DIR);
  }

  let current = path.resolve(startDirectory);
  while (path.dirname(current) !== current) {
    if (path.basename(current).toLowerCase() === "ra2md-ext") {
      return path.join(current, "demo-video", "exports");
    }
    current = path.dirname(current);
  }

  const repositoryRoot = path.resolve(startDirectory, "..");
  return path.join(repositoryRoot, ".runtime", "RA2MD-Ext", "demo-video", "exports");
}

function companionPath(videoPath, suffix) {
  return path.join(
    path.dirname(videoPath),
    `${path.basename(videoPath, path.extname(videoPath))}.${suffix}.json`,
  );
}

module.exports = { companionPath, demoExportDirectory };
