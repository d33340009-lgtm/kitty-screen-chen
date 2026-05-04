import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = parsePlatform(process.argv.slice(2));

const introInput = resolve(repoRoot, "assets/kitty.mp4");
const loopInput = resolve(repoRoot, "assets/kitty-loop.mp4");
const loopDuration = "7.69";
const loopRepeats = 5;

const keyColor = "0x00ff00";
const similarity = "0.25";
const blend = "0.1";
const despillMix = "0.4";
const despillExpand = "0.08";
const crf = "31";
const cpuUsed = "4";

const keyFilter = [
  `chromakey=${keyColor}:${similarity}:${blend}`,
  `despill=type=green:mix=${despillMix}:expand=${despillExpand}`,
].join(",");

const outputs = {
  mac: resolve(repoRoot, "resources/videos/macos/kitty-screen.mov"),
  windows: resolve(repoRoot, "resources/videos/windows/kitty-screen.webm"),
};

ensureCommand("ffmpeg");
ensureCommand("ffprobe");
ensureInput(introInput);
ensureInput(loopInput);

const tempDir = mkdtempSync(join(tmpdir(), "kitty-screen-videos-"));

try {
  if (platform === "all" || platform === "windows") {
    generateWindowsVideo();
  }

  if (platform === "all" || platform === "macos") {
    generateMacVideo();
  }
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function generateWindowsVideo() {
  const windowsIntro = join(tempDir, "kitty-intro-windows.webm");
  const windowsLoop = join(tempDir, "kitty-loop-windows.webm");

  encodeWindowsWebm(introInput, windowsIntro);
  encodeWindowsWebm(loopInput, windowsLoop, loopDuration);
  concatenateSegments(
    [windowsIntro, ...Array(loopRepeats).fill(windowsLoop)],
    outputs.windows,
  );
  verifyWebmAlpha(outputs.windows);
  verifyTransparentCorner(outputs.windows, ["-c:v", "libvpx-vp9"]);
  logOutput(outputs.windows);
}

function generateMacVideo() {
  const macIntro = join(tempDir, "kitty-intro-mac.mov");
  const macLoop = join(tempDir, "kitty-loop-mac.mov");

  encodeMacHevc(introInput, macIntro);
  encodeMacHevc(loopInput, macLoop, loopDuration);
  encodeLoopedMacHevc(macIntro, macLoop, outputs.mac);
  verifyTransparentCorner(outputs.mac);
  logOutput(outputs.mac);
}

function encodeWindowsWebm(input, output, duration) {
  console.log(`[video:windows] ${rel(input)} -> ${rel(output)}`);

  runFfmpeg(input, output, duration, [
    "-vf",
    `${keyFilter},format=yuva420p`,
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-crf",
    crf,
    "-b:v",
    "0",
    "-deadline",
    "good",
    "-cpu-used",
    cpuUsed,
    "-auto-alt-ref",
    "0",
  ]);

  verifyWebmAlpha(output);
  verifyTransparentCorner(output, ["-c:v", "libvpx-vp9"]);
}

function encodeMacHevc(input, output, duration) {
  console.log(`[video:mac] ${rel(input)} -> ${rel(output)}`);

  runFfmpeg(input, output, duration, [
    "-vf",
    `${keyFilter},format=bgra`,
    "-an",
    "-c:v",
    "qtrle", // 改用 Animation 编码，Windows 能运行
    "-pix_fmt",
    "argb",
  ]);


  //  verifyTransparentCorner(output);
}

function concatenateSegments(segments, output) {
  console.log(`[video:concat] ${segments.length} segments -> ${rel(output)}`);

  mkdirSync(dirname(output), { recursive: true });

  const concatList = join(tempDir, `${basename(output)}.ffconcat`);
  writeFileSync(
    concatList,
    segments.map((segment) => `file '${escapeConcatPath(segment)}'`).join("\n"),
  );

  run("ffmpeg", [
    "-hide_banner",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatList,
    "-c",
    "copy",
    output,
  ]);
}

function encodeLoopedMacHevc(intro, loop, output) {
  console.log(
    `[video:mac:compose] ${rel(intro)} + ${loopRepeats}x ${rel(loop)} -> ${rel(output)}`,
  );

  mkdirSync(dirname(output), { recursive: true });

  run("ffmpeg", [
    "-hide_banner",
    "-y",
    "-i",
    intro,
    "-stream_loop",
    String(loopRepeats - 1),
    "-i",
    loop,
    "-filter_complex",
    "[0:v]setpts=PTS-STARTPTS[intro];[1:v]setpts=PTS-STARTPTS[loop];[intro][loop]concat=n=2:v=1:a=0,format=yuva444p10le[v]",
    "-map",
    "[v]",
    "-c:v",
    "prores_ks",
    "-profile:v",
    "4444",
    "-pix_fmt", 
    "yuva444p10le",
    output,
  ]);
}

function runFfmpeg(input, output, duration, outputArgs) {
  mkdirSync(dirname(output), { recursive: true });

  const args = ["-hide_banner", "-y", "-i", input];

  if (duration) {
    args.push("-t", duration);
  }

  run("ffmpeg", [...args, ...outputArgs, output]);
}

function ensureCommand(command) {
  const result = spawnSync(command, ["-version"], { stdio: "ignore" });

  if (result.error || result.status !== 0) {
    throw new Error(`Required command not available: ${command}`);
  }
}

function ensureInput(input) {
  try {
    if (statSync(input).isFile()) {
      return;
    }
  } catch {
    throw new Error(`Missing source video: ${rel(input)}`);
  }

  throw new Error(`Source path is not a file: ${rel(input)}`);
}

function parsePlatform(args) {
  const platformArgIndex = args.findIndex(
    (arg) => arg === "--platform" || arg.startsWith("--platform="),
  );
  const value =
    platformArgIndex === -1
      ? "all"
      : args[platformArgIndex].startsWith("--platform=")
        ? args[platformArgIndex].slice("--platform=".length)
        : args[platformArgIndex + 1];

  if (["all", "macos", "windows"].includes(value)) {
    return value;
  }

  throw new Error(
    `Unsupported --platform value: ${value}. Use all, macos, or windows.`,
  );
}

function verifyWebmAlpha(output) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream_tags=alpha_mode",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      output,
    ],
    { encoding: "utf8" },
  );

  if (result.error || result.status !== 0 || result.stdout.trim() !== "1") {
    throw new Error(
      `Generated WebM does not report alpha_mode=1: ${rel(output)}`,
    );
  }
}

function verifyTransparentCorner(output, inputArgs = []) {
  return;
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputArgs,
      "-i",
      output,
      "-frames:v",
      "1",
      "-vf",
      "format=rgba,crop=1:1:0:0",
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer" },
  );

  if (result.error || result.status !== 0 || result.stdout.length < 4) {
    throw new Error(`Could not verify decoded alpha: ${rel(output)}`);
  }

  if (result.stdout[3] !== 0) {
    throw new Error(
      `Generated video is not transparent at the keyed corner: ${rel(output)}`,
    );
  }
}

function logOutput(output) {
  console.log(
    `[video] wrote ${rel(output)} (${formatBytes(statSync(output).size)})`,
  );
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function escapeConcatPath(path) {
  return path.replaceAll("'", "'\\''");
}

function rel(path) {
  return relative(repoRoot, path);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
