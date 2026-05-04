import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

ensureCommand("gh", ["--version"]);
run("gh", ["auth", "status"]);

const packageJson = JSON.parse(
  readFileSync(resolve(rootDir, "package.json"), "utf8"),
);
const version = normalizeVersion(options.version ?? packageJson.version);
const tag = `v${version}`;

if (options.build) {
  run("bun", ["run", "app:build:windows"]);
}

run("gh", ["release", "view", tag]);

const artifacts =
  options.artifacts.length > 0
    ? options.artifacts.map((artifact) => resolve(rootDir, artifact))
    : findWindowsArtifacts(version);

if (artifacts.length === 0) {
  throw new Error(
    `No Windows NSIS installer found for ${version}. Run \`bun run app:build:windows\` first.`,
  );
}

for (const artifact of artifacts) {
  if (!existsSync(artifact) || !statSync(artifact).isFile()) {
    throw new Error(`Artifact not found: ${artifact}`);
  }
}

console.log("[release:windows:upload] artifacts:");
for (const artifact of artifacts) {
  console.log(`  - ${rel(artifact)}`);
}

const uploadArtifacts = prepareUploadArtifacts(artifacts, version);

console.log("[release:windows:upload] upload names:");
for (const artifact of uploadArtifacts) {
  console.log(`  - ${rel(artifact)}`);
}

run("gh", ["release", "upload", tag, ...uploadArtifacts, "--clobber"]);
console.log(`[release:windows:upload] uploaded Windows artifacts to ${tag}`);

function parseArgs(args) {
  const parsed = {
    artifacts: [],
    build: false,
    help: false,
    version: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--build") {
      parsed.build = true;
      continue;
    }

    if (arg === "--artifact") {
      parsed.artifacts.push(takeValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith("--artifact=")) {
      parsed.artifacts.push(arg.slice("--artifact=".length));
      continue;
    }

    if (arg === "--version" || arg === "--tag") {
      parsed.version = takeValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--version=")) {
      parsed.version = arg.slice("--version=".length);
      continue;
    }

    if (arg.startsWith("--tag=")) {
      parsed.version = arg.slice("--tag=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (parsed.version) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    parsed.version = arg;
  }

  return parsed;
}

function printHelp() {
  console.log(`
Usage:
  bun run release:windows:upload -- [vX.Y.Z|X.Y.Z] [options]

Options:
  --build                 Run app:build:windows before uploading.
  --artifact <path>       Upload a specific artifact. Can be repeated.
  --version <version>     Release version or tag. Defaults to package.json.
  --tag <tag>             Same as --version.

Examples:
  bun run release:windows:upload -- v0.2.0
  bun run release:windows:upload -- 0.2.0 --build
`);
}

function takeValue(args, index, name) {
  const value = args[index + 1];

  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${name}`);
  }

  return value;
}

function normalizeVersion(input) {
  const normalized = input.startsWith("v") ? input.slice(1) : input;

  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`Invalid release version or tag: ${input}`);
  }

  return normalized;
}

function findWindowsArtifacts(version) {
  const targetDir = resolve(rootDir, "src-tauri", "target");

  if (!existsSync(targetDir)) {
    return [];
  }

  const installers = findFiles(targetDir, (path) => {
    const normalized = path.replaceAll("\\", "/");
    return normalized.includes("/bundle/nsis/") && /\.exe$/i.test(path);
  });
  const versionMatches = installers.filter((path) =>
    basename(path).includes(version),
  );

  if (versionMatches.length > 0) {
    return versionMatches.sort(compareByModifiedTimeDesc);
  }

  if (installers.length === 1) {
    return installers;
  }

  if (installers.length > 1) {
    throw new Error(
      [
        `Found multiple Windows installers, but none matched ${version}:`,
        ...installers.map((path) => `  - ${rel(path)}`),
        "Pass --artifact <path> to upload a specific file.",
      ].join("\n"),
    );
  }

  return [];
}

function prepareUploadArtifacts(artifacts, version) {
  const uploadDir = resolve(rootDir, "tmp", "release-artifacts", `v${version}`);

  rmSync(uploadDir, { force: true, recursive: true });
  mkdirSync(uploadDir, { recursive: true });

  return artifacts.map((artifact, index) => {
    const classifier = inferWindowsClassifier(artifact);
    const suffix = classifier ? `windows-${classifier}-setup` : "windows-setup";
    const output = resolve(
      uploadDir,
      uniqueArtifactName(
        uploadDir,
        `Kitty-Screen_${version}_${suffix}${extname(artifact)}`,
        index,
      ),
    );

    copyFileSync(artifact, output);
    return output;
  });
}

function inferWindowsClassifier(path) {
  const name = basename(path).toLowerCase();

  if (name.includes("aarch64") || name.includes("arm64")) {
    return "arm64";
  }

  if (
    name.includes("x86_64") ||
    name.includes("x64") ||
    name.includes("amd64")
  ) {
    return "x64";
  }

  if (name.includes("i686") || name.includes("x86")) {
    return "x86";
  }

  return null;
}

function uniqueArtifactName(dir, name, index) {
  const path = resolve(dir, name);

  if (!existsSync(path)) {
    return name;
  }

  const extension = extname(name);
  const stem = name.slice(0, -extension.length);
  return `${stem}-${index + 1}${extension}`;
}

function findFiles(dir, predicate) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findFiles(path, predicate));
      continue;
    }

    if (entry.isFile() && predicate(path)) {
      files.push(path);
    }
  }

  return files;
}

function compareByModifiedTimeDesc(left, right) {
  return statSync(right).mtimeMs - statSync(left).mtimeMs;
}

function ensureCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "ignore",
  });

  if (result.error || result.status !== 0) {
    throw new Error(`Required command not available: ${command}`);
  }
}

function run(command, args) {
  console.log(
    `[release:windows:upload] ${command} ${args.map(quoteArg).join(" ")}`,
  );

  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function quoteArg(arg) {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

function rel(path) {
  return relative(rootDir, path);
}
