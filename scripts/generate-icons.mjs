import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = resolve(rootDir, "assets");
const iconsDir = resolve(rootDir, "src-tauri", "icons");
const appIcon = resolve(assetsDir, "icon.png");
const trayIcon = resolve(assetsDir, "tray-icon.png");
const outputTrayIcon = resolve(iconsDir, "tray-icon.png");
const tauriBin = resolve(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);

function assertFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with code ${result.status}`,
    );
  }
}

assertFile(appIcon, "App icon source");
assertFile(trayIcon, "Tray icon source");
assertFile(tauriBin, "Tauri CLI");
mkdirSync(iconsDir, { recursive: true });

console.log("Generating app icons from assets/icon.png...");
run(tauriBin, ["icon", appIcon, "--output", iconsDir]);

if (process.platform !== "darwin") {
  throw new Error(
    "Tray icon generation uses macOS sips. Run this script on macOS.",
  );
}

console.log("Generating tray icon from assets/tray-icon.png...");
run(
  "sips",
  ["--resampleHeightWidth", "64", "64", trayIcon, "--out", outputTrayIcon],
  {
    stdio: "ignore",
  },
);

console.log("Done.");
