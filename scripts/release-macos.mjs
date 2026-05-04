import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  cargoLock: resolve(rootDir, "src-tauri", "Cargo.lock"),
  cargoToml: resolve(rootDir, "src-tauri", "Cargo.toml"),
  packageJson: resolve(rootDir, "package.json"),
  tauriConf: resolve(rootDir, "src-tauri", "tauri.conf.json"),
};

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

if (process.platform !== "darwin") {
  throw new Error("release:mac must run on macOS.");
}

ensureCommand("git", ["--version"]);
ensureCommand("gh", ["--version"]);
ensureCommand("bun", ["--version"]);

const packageJson = readJson(paths.packageJson);
const currentVersion = packageJson.version;
const nextVersion = resolveNextVersion(
  options.version ?? "patch",
  currentVersion,
);
const tag = `v${nextVersion}`;
const currentBranch = capture("git", ["branch", "--show-current"]).trim();

if (!currentBranch) {
  throw new Error("Could not determine the current git branch.");
}

ensureTagAvailable(tag, options.remote);
run("gh", ["auth", "status"]);

console.log(`[release:mac] ${currentVersion} -> ${nextVersion}`);
console.log(`[release:mac] branch ${currentBranch}, tag ${tag}`);

updateVersions(nextVersion);
run("bunx", [
  "prettier",
  "--write",
  "--log-level",
  "warn",
  "--ignore-unknown",
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
]);

run("bun", ["run", "app:build:mac"]);

const artifacts = findMacArtifacts(nextVersion);

if (artifacts.length === 0) {
  throw new Error(
    `No macOS dmg found for ${nextVersion}. Expected one under src-tauri/target/**/bundle/dmg.`,
  );
}

console.log("[release:mac] artifacts:");
for (const artifact of artifacts) {
  console.log(`  - ${rel(artifact)}`);
}

run("git", ["add", "-A"]);

if (commandSucceeds("git", ["diff", "--cached", "--quiet"])) {
  console.log("[release:mac] no staged changes; skipping commit");
} else {
  run("git", ["commit", "-m", `Release ${tag}`]);
}

run("git", ["tag", tag]);
run("git", ["push", options.remote, currentBranch]);
run("git", ["push", options.remote, tag]);

const uploadArtifacts = prepareUploadArtifacts(artifacts, nextVersion);

console.log("[release:mac] upload names:");
for (const artifact of uploadArtifacts) {
  console.log(`  - ${rel(artifact)}`);
}

const ghArgs = [
  "release",
  "create",
  tag,
  ...uploadArtifacts,
  "--title",
  `Kitty Screen ${tag}`,
];

if (options.notesFile) {
  ghArgs.push("--notes-file", options.notesFile);
} else {
  ghArgs.push("--notes", options.notes ?? `Release ${tag}`);
}

if (options.draft) {
  ghArgs.push("--draft");
}

if (options.prerelease) {
  ghArgs.push("--prerelease");
}

run("gh", ghArgs);
console.log(`[release:mac] created GitHub Release ${tag}`);
console.log(
  `[release:mac] after the Windows build, run: bun run release:windows:upload -- ${tag}`,
);

function parseArgs(args) {
  const parsed = {
    draft: false,
    help: false,
    notes: null,
    notesFile: null,
    prerelease: false,
    remote: "origin",
    version: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--draft") {
      parsed.draft = true;
      continue;
    }

    if (arg === "--prerelease") {
      parsed.prerelease = true;
      continue;
    }

    if (arg === "--version") {
      parsed.version = takeValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--version=")) {
      parsed.version = arg.slice("--version=".length);
      continue;
    }

    if (arg === "--notes") {
      parsed.notes = takeValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--notes=")) {
      parsed.notes = arg.slice("--notes=".length);
      continue;
    }

    if (arg === "--notes-file") {
      parsed.notesFile = takeValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--notes-file=")) {
      parsed.notesFile = arg.slice("--notes-file=".length);
      continue;
    }

    if (arg === "--remote") {
      parsed.remote = takeValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--remote=")) {
      parsed.remote = arg.slice("--remote=".length);
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
  bun run release:mac -- [patch|minor|major|x.y.z] [options]

Options:
  --version <version>      Version or bump type. Defaults to patch.
  --notes <text>           GitHub release notes.
  --notes-file <path>      GitHub release notes file.
  --draft                  Create a draft release.
  --prerelease             Mark the release as prerelease.
  --remote <name>          Git remote to push. Defaults to origin.

Examples:
  bun run release:mac -- patch
  bun run release:mac -- 0.2.0 --notes "First public release"
`);
}

function takeValue(args, index, name) {
  const value = args[index + 1];

  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${name}`);
  }

  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveNextVersion(input, currentVersion) {
  if (["major", "minor", "patch"].includes(input)) {
    return bumpVersion(currentVersion, input);
  }

  const normalized = input.startsWith("v") ? input.slice(1) : input;

  if (!isStableSemver(normalized)) {
    throw new Error(
      `Invalid version "${input}". Use major, minor, patch, or x.y.z.`,
    );
  }

  return normalized;
}

function bumpVersion(version, level) {
  if (!isStableSemver(version)) {
    throw new Error(`Cannot bump non-standard semver: ${version}`);
  }

  const [major, minor, patch] = version.split(".").map(Number);

  if (level === "major") {
    return `${major + 1}.0.0`;
  }

  if (level === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  return `${major}.${minor}.${patch + 1}`;
}

function isStableSemver(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function updateVersions(version) {
  const nextPackageJson = readJson(paths.packageJson);
  nextPackageJson.version = version;
  writeJson(paths.packageJson, nextPackageJson);

  const nextTauriConf = readJson(paths.tauriConf);
  nextTauriConf.version = version;
  writeJson(paths.tauriConf, nextTauriConf);

  replaceInFile(
    paths.cargoToml,
    /(^\[package\][\s\S]*?^version = ")[^"]+(")/m,
    `$1${version}$2`,
  );

  if (existsSync(paths.cargoLock)) {
    replaceInFile(
      paths.cargoLock,
      /(\[\[package\]\]\nname = "kitty-screen"\nversion = ")[^"]+(")/,
      `$1${version}$2`,
    );
  }
}

function replaceInFile(path, pattern, replacement) {
  const content = readFileSync(path, "utf8");
  const nextContent = content.replace(pattern, replacement);

  if (nextContent === content) {
    throw new Error(`Could not update ${rel(path)}`);
  }

  writeFileSync(path, nextContent);
}

function ensureTagAvailable(tag, remote) {
  if (commandSucceeds("git", ["rev-parse", "--verify", `refs/tags/${tag}`])) {
    throw new Error(`Local tag already exists: ${tag}`);
  }

  if (capture("git", ["ls-remote", "--tags", remote, tag]).trim()) {
    throw new Error(`Remote tag already exists: ${tag}`);
  }

  if (commandSucceeds("gh", ["release", "view", tag])) {
    throw new Error(`GitHub Release already exists: ${tag}`);
  }
}

function findMacArtifacts(version) {
  const targetDir = resolve(rootDir, "src-tauri", "target");

  if (!existsSync(targetDir)) {
    return [];
  }

  return findFiles(targetDir, (path) => {
    const normalized = path.replaceAll("\\", "/");
    return (
      normalized.includes("/bundle/dmg/") &&
      path.endsWith(".dmg") &&
      basename(path).includes(version)
    );
  }).sort(compareByModifiedTimeDesc);
}

function prepareUploadArtifacts(artifacts, version) {
  const uploadDir = resolve(rootDir, "tmp", "release-artifacts", `v${version}`);

  rmSync(uploadDir, { force: true, recursive: true });
  mkdirSync(uploadDir, { recursive: true });

  return artifacts.map((artifact, index) => {
    const classifier = inferMacClassifier(artifact);
    const suffix = classifier ? `macos-${classifier}` : "macos";
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

function inferMacClassifier(path) {
  const name = basename(path).toLowerCase();

  if (name.includes("universal")) {
    return "universal";
  }

  if (name.includes("aarch64") || name.includes("arm64")) {
    return "arm64";
  }

  if (name.includes("x86_64") || name.includes("x64")) {
    return "x64";
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

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "ignore",
  });

  return !result.error && result.status === 0;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr.trim()}`,
    );
  }

  return result.stdout;
}

function run(command, args) {
  console.log(`[release:mac] ${command} ${args.map(quoteArg).join(" ")}`);

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
