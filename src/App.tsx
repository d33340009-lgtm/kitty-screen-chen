import FlipClockCountdown from "@leenguyen/react-flip-clock-countdown";
import "@leenguyen/react-flip-clock-countdown/dist/index.css";
import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resolveResource } from "@tauri-apps/api/path";
import { Check, ExternalLink, Play, Power } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./App.css";
import { Button } from "./components/ui/pixelact-ui/button";
import { Label } from "./components/ui/pixelact-ui/label";
import type { Locales, TranslationFunctions } from "./i18n/i18n-types";
import { i18nObject } from "./i18n/i18n-util";
import { loadAllLocales } from "./i18n/i18n-util.sync";
import appLogo from "./assets/app-logo.png";

loadAllLocales();

type Settings = { delaySeconds: number; durationSeconds: number; locale: Locales; };
type ScreensaverState = { isShowing: boolean; durationSeconds: number; endsAtMs: number; mode: "scheduled" | "manual" | "preview"; generation: number; };
type GitHubRelease = { draft?: boolean; html_url?: string; prerelease?: boolean; tag_name?: string; };
type ReleasePackageJson = { version?: string; };
type UpdateInfo = { url: string; version: string; };
type UpdateCheckCache = { checkedAt: number; release: UpdateInfo | null; };

const SUPPORTED_LOCALES = ["en", "zh-CN", "zh-HK", "zh-TW", "ja", "ko", "es", "fr", "pt"] as const satisfies readonly Locales[];
const DEFAULT_LOCALE: Locales = "zh-CN";
const DEFAULT_SETTINGS: Settings = { delaySeconds: 30 * 60, durationSeconds: 30, locale: DEFAULT_LOCALE };
const CLOCK_REVEAL_DELAY_MS = 10_000;
const LOOP_REPLAY_START_SECONDS = 8.466;
const LOOP_REPLAY_END_PADDING_SECONDS = 0.18;
const GITHUB_REPOSITORY = "elliothux/kitty-screen";
const GITHUB_URL = "https://github.com/elliothux/kitty-screen";
const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;
const GITHUB_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
const JSDELIVR_LATEST_PACKAGE_URL = `https://cdn.jsdelivr.net/gh/${GITHUB_REPOSITORY}@latest/package.json`;
const UPDATE_CHECK_CACHE_KEY = "kitty-screen:update-check";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 8_000;
const DEFAULT_SCREENSAVER_STATE: ScreensaverState = { isShowing: false, durationSeconds: 30, endsAtMs: 0, mode: "scheduled", generation: 0 };

function isScreensaverRoute() { return new URLSearchParams(window.location.search).has("screensaver"); }
function isApplePlatform() { const platform = navigator.platform || ""; const userAgent = navigator.userAgent || ""; return /mac|iphone|ipad|ipod/i.test(platform + userAgent); }
function screensaverVideoResourcePath() { if (isApplePlatform()) { return "resources/videos/macos/kitty-screen-mac.mov"; } return "videos/kitty-screen-windows.webm"; }
function isSupportedLocale(locale: string): locale is Locales { return SUPPORTED_LOCALES.includes(locale as Locales); }
function normalizeSettings(settings: Partial<Settings>): Settings { return { delaySeconds: settings.delaySeconds ?? DEFAULT_SETTINGS.delaySeconds, durationSeconds: settings.durationSeconds ?? DEFAULT_SETTINGS.durationSeconds, locale: settings.locale && isSupportedLocale(settings.locale) ? settings.locale : DEFAULT_LOCALE }; }
function normalizeVersion(version: string) { return version.trim().replace(/^v/i, "").split(/[+-]/)[0] ?? ""; }
function parseVersion(version: string) { const normalized = normalizeVersion(version); if (!/^\d+(?:\.\d+){0,2}$/.test(normalized)) { return null; } const parts = normalized.split(".").map((part) => Number(part)); while (parts.length < 3) { parts.push(0); } return parts; }
function compareVersions(left: string, right: string) { const leftParts = parseVersion(left); const rightParts = parseVersion(right); if (!leftParts || !rightParts) { return 0; } for (let index = 0; index < 3; index += 1) { const difference = leftParts[index] - rightParts[index]; if (difference !== 0) { return difference; } } return 0; }
function releaseToUpdateInfo(release: GitHubRelease): UpdateInfo | null { const version = release.tag_name?.trim(); if (!version || release.draft || release.prerelease) { return null; } return { url: release.html_url ?? GITHUB_RELEASES_URL, version }; }
function versionToReleaseTag(version: string) { const normalized = normalizeVersion(version); return normalized ? `v${normalized}` : ""; }
function packageJsonToUpdateInfo(packageJson: ReleasePackageJson): UpdateInfo | null { const tag = versionToReleaseTag(packageJson.version ?? ""); if (!tag) { return null; } return { url: `${GITHUB_RELEASES_URL}/tag/${tag}`, version: tag }; }
function readUpdateCheckCache(): UpdateCheckCache | null { try { const raw = localStorage.getItem(UPDATE_CHECK_CACHE_KEY); if (!raw) { return null; } const parsed = JSON.parse(raw) as Partial<UpdateCheckCache>; if (typeof parsed.checkedAt !== "number") { return null; } return { checkedAt: parsed.checkedAt, release: parsed.release ?? null }; } catch { return null; } }
function writeUpdateCheckCache(release: UpdateInfo | null) { try { localStorage.setItem(UPDATE_CHECK_CACHE_KEY, JSON.stringify({ checkedAt: Date.now(), release })); } catch { } }
function availableUpdateFromRelease(release: UpdateInfo | null, currentVersion: string) { if (!release) { return null; } return compareVersions(release.version, currentVersion) > 0 ? release : null; }

async function fetchJson<T>(url: string, headers: Record<string, string> = { Accept: "application/json" }) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", headers, signal: controller.signal });
    if (!response.ok) { throw new Error(`Update check failed: ${response.status}`); }
    return (await response.json()) as T;
  } finally { window.clearTimeout(timeout); }
}

async function fetchLatestUpdateInfo() {
  try { return releaseToUpdateInfo(await fetchJson<GitHubRelease>(GITHUB_LATEST_RELEASE_API_URL, { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" })); } catch { }
  return packageJsonToUpdateInfo(await fetchJson<ReleasePackageJson>(JSDELIVR_LATEST_PACKAGE_URL));
}

async function checkForAvailableUpdate() {
  const currentVersion = await getVersion();
  const cached = readUpdateCheckCache();
  if (cached && Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) { return availableUpdateFromRelease(cached.release, currentVersion); }
  try {
    const release = await fetchLatestUpdateInfo();
    writeUpdateCheckCache(release);
    return availableUpdateFromRelease(release, currentVersion);
  } catch { return availableUpdateFromRelease(cached?.release ?? null, currentVersion); }
}

function delayOptions(LL: TranslationFunctions) { return [{ label: LL.durations.minutes15(), value: 15 * 60 }, { label: LL.durations.minutes30(), value: 30 * 60 }, { label: LL.durations.hours1(), value: 60 * 60 }, { label: LL.durations.hours1_5(), value: 90 * 60 }, { label: LL.durations.hours2(), value: 120 * 60 }, { label: LL.durations.hours3(), value: 180 * 60 }]; }
function durationOptions(LL: TranslationFunctions) { return [{ label: LL.durations.seconds15(), value: 15 }, { label: LL.durations.seconds30(), value: 30 }, { label: LL.durations.minutes1(), value: 60 }, { label: LL.durations.minutes1_5(), value: 90 }, { label: LL.durations.minutes2(), value: 120 }, { label: LL.durations.minutes3(), value: 180 }, { label: LL.durations.minutes5(), value: 300 }, { label: LL.durations.minutes10(), value: 600 }, { label: LL.durations.minutes15(), value: 900 }, { label: LL.durations.minutes30(), value: 1800 }]; }
function languageOptions(LL: TranslationFunctions) { return [{ label: LL.languages.en(), value: "en" }, { label: LL.languages.zhCN(), value: "zh-CN" }, { label: LL.languages.zhHK(), value: "zh-HK" }, { label: LL.languages.zhTW(), value: "zh-TW" }, { label: LL.languages.ja(), value: "ja" }, { label: LL.languages.ko(), value: "ko" }, { label: LL.languages.es(), value: "es" }, { label: LL.languages.fr(), value: "fr" }, { label: LL.languages.pt(), value: "pt" }] as Array<{ label: ReactNode; value: Locales }>; }

function OptionGroup<T extends number | string>({ id, label, value, options, onChange, variant = "default" }: { id: string; label: ReactNode; value: T; options: Array<{ label: ReactNode; value: T }>; onChange: (value: T) => void; variant?: "default" | "language"; }) {
  return (
    <section className="setting-row">
      <div className="setting-row__header"><Label>{label}</Label></div>
      <div className={`option-grid option-grid--${variant}`} role="group">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Button key={option.value} onClick={() => onChange(option.value)} size="sm" variant={active ? "success" : "default"}>
              {active && <Check aria-hidden="true" />}
              {option.label}
            </Button>
          );
        })}
      </div>
    </section>
  );
}

function App() {
  const isScreensaver = isScreensaverRoute();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [screensaverState, setScreensaverState] = useState<ScreensaverState>(DEFAULT_SCREENSAVER_STATE);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const LL = useMemo(() => i18nObject(settings.locale), [settings.locale]);

  const refreshScreensaverState = useCallback(async () => { try { setScreensaverState(await invoke<ScreensaverState>("get_screensaver_state")); } catch { } }, []);

  useEffect(() => {
    async function boot() {
      try {
        const [loadedSettings, overlay] = await Promise.all([invoke<Partial<Settings>>("get_settings"), invoke<ScreensaverState>("get_screensaver_state")]);
        setSettings(normalizeSettings(loadedSettings));
        setScreensaverState(overlay);
      } catch { }
      listen<ScreensaverState>("screensaver://state", (event) => setScreensaverState(event.payload));
      listen<Partial<Settings>>("settings://changed", (event) => setSettings(normalizeSettings(event.payload)));
    }
    boot();
  }, []);

  useEffect(() => { document.documentElement.lang = settings.locale; }, [settings.locale]);
  useEffect(() => {
    if (isScreensaver) return;
    checkForAvailableUpdate().then(setUpdateInfo);
  }, [isScreensaver]);

  const saveSettings = useCallback(async (next: Settings) => {
    setSettings(next);
    setIsSaving(true);
    try {
      const saved = await invoke<Settings>("save_settings", { settings: next });
      setSettings(normalizeSettings(saved));
      await refreshScreensaverState();
    } finally { setIsSaving(false); }
  }, [refreshScreensaverState]);

  if (isScreensaver) return <ScreensaverView LL={LL} state={screensaverState} />;

  return (
    <main className="settings-shell">
      <section className="settings-panel">
        <header className="settings-header">
          <img src={appLogo} className="settings-title-icon" alt="" />
          <h1 className="settings-title">Kitty Screen</h1>
        </header>
        <OptionGroup id="delay" label={LL.settings.delayLabel()} value={settings.delaySeconds} options={delayOptions(LL)} onChange={(v) => saveSettings({ ...settings, delaySeconds: v })} />
        <OptionGroup id="duration" label={LL.settings.durationLabel()} value={settings.durationSeconds} options={durationOptions(LL)} onChange={(v) => saveSettings({ ...settings, durationSeconds: v })} />
        <OptionGroup id="language" label={LL.settings.languageLabel()} value={settings.locale} options={languageOptions(LL)} onChange={(v) => saveSettings({ ...settings, locale: v })} variant="language" />
        <footer className="settings-footer">
          <Button onClick={() => invoke("preview_screensaver")} size="lg" variant="warning"><Play />{LL.settings.preview()}</Button>
        </footer>
      </section>
    </main>
  );
}

function ScreensaverView({ LL, state }: { LL: TranslationFunctions; state: ScreensaverState; }) {
  const [showClock, setShowClock] = useState(false);
  const [videoSource, setVideoSource] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isReplayingLoopRef = useRef(false);
  const target = useMemo(() => state.endsAtMs > Date.now() ? state.endsAtMs : Date.now() + 1000, [state.endsAtMs, state.generation]);

  useEffect(() => {
    resolveResource(screensaverVideoResourcePath()).then((path) => setVideoSource(convertFileSrc(path))).catch(console.error);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!state.isShowing) { video?.pause(); if (video) video.currentTime = 0; return; }
    if (video && videoSource) { video.currentTime = 0; video.play().catch(console.error); }
    const timer = setTimeout(() => setShowClock(true), CLOCK_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state.generation, state.isShowing, videoSource]);

  const replayLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video || isReplayingLoopRef.current) return;
    isReplayingLoopRef.current = true;
    video.currentTime = LOOP_REPLAY_START_SECONDS;
    video.play().catch(console.error);
  }, []);

  return (
    <main className="screensaver">
      <video ref={videoRef} className="screensaver__video" muted playsInline preload="auto" src={videoSource ?? undefined} onEnded={replayLoop} onSeeked={() => { isReplayingLoopRef.current = false; }} onTimeUpdate={() => {
        const video = videoRef.current;
        if (video && !isReplayingLoopRef.current && video.duration - video.currentTime <= LOOP_REPLAY_END_PADDING_SECONDS) replayLoop();
      }} />
      <section className="screensaver__content" data-visible={showClock}>
        <FlipClockCountdown to={target} labels={["D", "H", "M", "S"]} showLabels={false} onComplete={() => invoke("hide_screensaver")} />
      </section>
      <Button className="screensaver__close" onClick={() => invoke("hide_screensaver")} size="icon" variant="destructive"><Power /></Button>
    </main>
  );
}

export default App;
