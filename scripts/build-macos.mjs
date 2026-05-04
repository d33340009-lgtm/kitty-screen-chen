import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(rootDir, ".env");
const tauriBin = resolve(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);

const { customFlags, tauriArgs } = parseArgs(process.argv.slice(2));
const env = {
  ...process.env,
  ...loadDotEnv(envPath),
};

if (customFlags.skipNotarization) {
  removeNotarizationCredentials(env);
} else {
  normalizeNotarizationCredentials(env);
}

if (process.platform !== "darwin") {
  throw new Error("macOS packaging must run on macOS.");
}

if (!existsSync(tauriBin)) {
  throw new Error("Tauri CLI not found. Run `bun install` first.");
}

if (
  !customFlags.noSign &&
  !hasAny(env, ["APPLE_SIGNING_IDENTITY", "APPLE_CERTIFICATE"])
) {
  throw new Error(
    "Missing APPLE_SIGNING_IDENTITY in .env. Run `security find-identity -v -p codesigning` to find it.",
  );
}

if (customFlags.requireNotarization && !hasNotarizationCredentials(env)) {
  throw new Error(
    [
      "Missing notarization credentials in .env.",
      "Set APPLE_API_KEY to the AuthKey .p8 path, APPLE_API_KEY_ID to the key ID, and APPLE_API_ISSUER to the issuer ID.",
    ].join("\n"),
  );
}

const args = ["build", ...tauriArgs];
console.log(`[macos-build] ${relativeCommand(tauriBin)} ${args.join(" ")}`);
console.log(`[macos-build] loaded ${relativeCommand(envPath)}`);

const result = spawnSync(tauriBin, args, {
  cwd: rootDir,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

function parseArgs(args) {
  const customFlags = {
    noSign: false,
    requireNotarization: false,
    skipNotarization: false,
  };
  const tauriArgs = [];

  for (const arg of args) {
    if (arg === "--require-notarization") {
      customFlags.requireNotarization = true;
      continue;
    }

    if (arg === "--skip-notarization") {
      customFlags.skipNotarization = true;
      continue;
    }

    if (arg === "--no-sign") {
      customFlags.noSign = true;
    }

    tauriArgs.push(arg);
  }

  return { customFlags, tauriArgs };
}

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return {};
  }

  const values = {};

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    const value = parseEnvValue(normalized.slice(separatorIndex + 1).trim());

    if (key && value) {
      values[key] = value;
    }
  }

  return values;
}

function parseEnvValue(value) {
  const quote = value[0];

  if (
    (quote === '"' || quote === "'") &&
    value.length >= 2 &&
    value[value.length - 1] === quote
  ) {
    return value.slice(1, -1);
  }

  const commentIndex = value.indexOf(" #");
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim();
}

function hasAny(env, keys) {
  return keys.some((key) => Boolean(env[key]));
}

function hasNotarizationCredentials(env) {
  return Boolean(
    env.APPLE_API_KEY && env.APPLE_API_ISSUER && env.APPLE_API_KEY_PATH,
  );
}

function normalizeNotarizationCredentials(env) {
  if (!env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) {
    return;
  }

  const apiKeyPath = resolveEnvPath(env.APPLE_API_KEY);

  if (!existsSync(apiKeyPath)) {
    throw new Error(`APPLE_API_KEY file not found: ${apiKeyPath}`);
  }

  // Tauri expects APPLE_API_KEY to be the key ID and APPLE_API_KEY_PATH to be
  // the .p8 file path. Our .env follows the Electron/Lynx convention.
  env.APPLE_API_KEY_PATH = apiKeyPath;
  env.APPLE_API_KEY = env.APPLE_API_KEY_ID;
  delete env.APPLE_API_KEY_ID;
  delete env.APPLE_ID;
  delete env.APPLE_PASSWORD;
  delete env.APPLE_TEAM_ID;
}

function removeNotarizationCredentials(env) {
  for (const key of [
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_KEY_PATH",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_PROVIDER_SHORT_NAME",
    "APPLE_TEAM_ID",
  ]) {
    delete env[key];
  }
}

function relativeCommand(path) {
  return path.startsWith(rootDir) ? path.slice(rootDir.length + 1) : path;
}

function resolveEnvPath(path) {
  return path.startsWith("/") ? path : resolve(rootDir, path);
}
