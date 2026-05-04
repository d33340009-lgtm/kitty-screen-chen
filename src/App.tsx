import FlipClockCountdown from "@leenguyen/react-flip-clock-countdown";
import "@leenguyen/react-flip-clock-countdown/dist/index.css";
import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resolveResource } from "@tauri-apps/api/path";
import { Check, ExternalLink, Play, Power } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./App.css";
import { Button } from "./components/ui/pixelact-ui/button";
import { Label } from "./components/ui/pixelact-ui/label";
import type { Locales, TranslationFunctions } from "./i18n/i18n-types";
import { i18nObject } from "./i18n/i18n-util";
import { loadAllLocales } from "./i18n/i18n-util.sync";

import appLogo from "./assets/app-logo.png";

loadAllLocales();

type Settings = {
  delaySeconds: number;
  durationSeconds: number;
  locale: Locales;
};

type ScreensaverState = {
  isShowing: boolean;
  durationSeconds: number;
  endsAtMs: number;
  mode: "scheduled" | "manual" | "preview";
  generation: number;
};

type GitHubRelease = {
  draft?: boolean;
  html_url?: string;
  prerelease?: boolean;
  tag_name?: string;
};

type ReleasePackageJson = {
  version?: string;
};

type UpdateInfo = {
  url: string;
  version: string;
};

type UpdateCheckCache = {
  checkedAt: number;
  release: UpdateInfo | null;
};

const SUPPORTED_LOCALES = [
  "en",
  "zh-CN",
  "zh-HK",
  "zh-TW",
  "ja",
  "ko",
  "es",
  "fr",
  "pt",
] as const satisfies readonly Locales[];

const DEFAULT_LOCALE: Locales = "zh-CN";

const DEFAULT_SETTINGS: Settings = {
  delaySeconds: 30 * 60,
  durationSeconds: 30,
  locale: DEFAULT_LOCALE,
};

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

const DEFAULT_SCREENSAVER_STATE: ScreensaverState = {
  isShowing: false,
  durationSeconds: 30,
  endsAtMs: 0,
  mode: "scheduled",
  generation: 0,
};

function isScreensaverRoute() {
  return new URLSearchParams(window.location.search).has("screensaver");
}

function isApplePlatform() {
  const platform = navigator.platform || "";
  const userAgent = navigator.userAgent || "";

  return /mac|iphone|ipad|ipod/i.test(platform + userAgent);
}

function screensaverVideoResourcePath() {
  return isApplePlatform()
    ? "videos/kitty-screen-mac.mov"
    : "videos/kitty-screen-windows.webm";
}

function isSupportedLocale(locale: string): locale is Locales {
  return SUPPORTED_LOCALES.includes(locale as Locales);
}

function normalizeSettings(settings: Partial<Settings>): Settings {
  return {
    delaySeconds: settings.delaySeconds ?? DEFAULT_SETTINGS.delaySeconds,
    durationSeconds:
      settings.durationSeconds ?? DEFAULT_SETTINGS.durationSeconds,
    locale:
      settings.locale && isSupportedLocale(settings.locale)
        ? settings.locale
        : DEFAULT_LOCALE,
  };
}

function normalizeVersion(version: string) {
  return version.trim().replace(/^v/i, "").split(/[+-]/)[0] ?? "";
}

function parseVersion(version: string) {
  const normalized = normalizeVersion(version);

  if (!/^\d+(?:\.\d+){0,2}$/.test(normalized)) {
    return null;
  }

  const parts = normalized.split(".").map((part) => Number(part));

  while (parts.length < 3) {
    parts.push(0);
  }

  return parts;
}

function compareVersions(left: string, right: string) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  if (!leftParts || !rightParts) {
    return 0;
  }

  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function releaseToUpdateInfo(release: GitHubRelease): UpdateInfo | null {
  const version = release.tag_name?.trim();

  if (!version || release.draft || release.prerelease) {
    return null;
  }

  return {
    url: release.html_url ?? GITHUB_RELEASES_URL,
    version,
  };
}

function versionToReleaseTag(version: string) {
  const normalized = normalizeVersion(version);
  return normalized ? `v${normalized}` : "";
}

function packageJsonToUpdateInfo(
  packageJson: ReleasePackageJson,
): UpdateInfo | null {
  const tag = versionToReleaseTag(packageJson.version ?? "");

  if (!tag) {
    return null;
  }

  return {
    url: `${GITHUB_RELEASES_URL}/tag/${tag}`,
    version: tag,
  };
}

function readUpdateCheckCache(): UpdateCheckCache | null {
  try {
    const raw = localStorage.getItem(UPDATE_CHECK_CACHE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<UpdateCheckCache>;

    if (typeof parsed.checkedAt !== "number") {
      return null;
    }

    return {
      checkedAt: parsed.checkedAt,
      release: parsed.release ?? null,
    };
  } catch {
    return null;
  }
}

function writeUpdateCheckCache(release: UpdateInfo | null) {
  try {
    localStorage.setItem(
      UPDATE_CHECK_CACHE_KEY,
      JSON.stringify({ checkedAt: Date.now(), release }),
    );
  } catch {
    // Ignore private browsing or storage quota failures.
  }
}

function availableUpdateFromRelease(
  release: UpdateInfo | null,
  currentVersion: string,
) {
  if (!release) {
    return null;
  }

  return compareVersions(release.version, currentVersion) > 0 ? release : null;
}

async function fetchJson<T>(
  url: string,
  headers: Record<string, string> = { Accept: "application/json" },
) {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    UPDATE_CHECK_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Update check failed: ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchLatestUpdateInfo() {
  try {
    return releaseToUpdateInfo(
      await fetchJson<GitHubRelease>(GITHUB_LATEST_RELEASE_API_URL, {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
    );
  } catch (primaryError) {
    console.error(primaryError);
  }

  return packageJsonToUpdateInfo(
    await fetchJson<ReleasePackageJson>(JSDELIVR_LATEST_PACKAGE_URL),
  );
}

async function checkForAvailableUpdate() {
  const currentVersion = await getVersion();
  const cached = readUpdateCheckCache();

  if (cached && Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
    return availableUpdateFromRelease(cached.release, currentVersion);
  }

  try {
    const release = await fetchLatestUpdateInfo();
    writeUpdateCheckCache(release);
    return availableUpdateFromRelease(release, currentVersion);
  } catch (error) {
    console.error(error);
    return availableUpdateFromRelease(cached?.release ?? null, currentVersion);
  }
}

function delayOptions(LL: TranslationFunctions) {
  return [
    { label: LL.durations.minutes15(), value: 15 * 60 },
    { label: LL.durations.minutes30(), value: 30 * 60 },
    { label: LL.durations.hours1(), value: 60 * 60 },
    { label: LL.durations.hours1_5(), value: 90 * 60 },
    { label: LL.durations.hours2(), value: 120 * 60 },
    { label: LL.durations.hours3(), value: 180 * 60 },
  ];
}

function durationOptions(LL: TranslationFunctions) {
  return [
    { label: LL.durations.seconds15(), value: 15 },
    { label: LL.durations.seconds30(), value: 30 },
    { label: LL.durations.minutes1(), value: 60 },
    { label: LL.durations.minutes1_5(), value: 90 },
    { label: LL.durations.minutes2(), value: 120 },
    { label: LL.durations.minutes3(), value: 180 },
    { label: LL.durations.minutes5(), value: 300 },
    { label: LL.durations.minutes10(), value: 600 },
    { label: LL.durations.minutes15(), value: 900 },
    { label: LL.durations.minutes30(), value: 1800 },
  ];
}

function languageOptions(LL: TranslationFunctions) {
  return [
    { label: LL.languages.en(), value: "en" },
    { label: LL.languages.zhCN(), value: "zh-CN" },
    { label: LL.languages.zhHK(), value: "zh-HK" },
    { label: LL.languages.zhTW(), value: "zh-TW" },
    { label: LL.languages.ja(), value: "ja" },
    { label: LL.languages.ko(), value: "ko" },
    { label: LL.languages.es(), value: "es" },
    { label: LL.languages.fr(), value: "fr" },
    { label: LL.languages.pt(), value: "pt" },
  ] satisfies Array<{ label: ReactNode; value: Locales }>;
}

type OptionValue = number | string;

type OptionGroupProps<T extends OptionValue> = {
  id: string;
  label: ReactNode;
  value: T;
  options: Array<{ label: ReactNode; value: T }>;
  onChange: (value: T) => void;
  variant?: "default" | "language";
};

function OptionGroup<T extends OptionValue>({
  id,
  label,
  value,
  options,
  onChange,
  variant = "default",
}: OptionGroupProps<T>) {
  return (
    <section className="setting-row" aria-labelledby={`${id}-label`}>
      <div className="setting-row__header">
        <Label id={`${id}-label`}>{label}</Label>
      </div>
      <div
        className={`option-grid option-grid--${variant}`}
        role="group"
        aria-labelledby={`${id}-label`}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Button
              key={option.value}
              aria-pressed={active}
              data-active={active ? "true" : undefined}
              data-option-value={option.value}
              onClick={() => onChange(option.value)}
              size="sm"
              variant={active ? "success" : "default"}
            >
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
  const [screensaverState, setScreensaverState] = useState<ScreensaverState>(
    DEFAULT_SCREENSAVER_STATE,
  );
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const LL = useMemo(() => i18nObject(settings.locale), [settings.locale]);
  const delayChoices = useMemo(() => delayOptions(LL), [LL]);
  const durationChoices = useMemo(() => durationOptions(LL), [LL]);
  const languageChoices = useMemo(() => languageOptions(LL), [LL]);

  const refreshScreensaverState = useCallback(async () => {
    try {
      const next = await invoke<ScreensaverState>("get_screensaver_state");
      setScreensaverState(next);
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    let unlistenScreensaver: (() => void) | undefined;
    let unlistenSettings: (() => void) | undefined;

    async function boot() {
      try {
        const [loadedSettings, overlay] = await Promise.all([
          invoke<Partial<Settings>>("get_settings"),
          invoke<ScreensaverState>("get_screensaver_state"),
        ]);
        setSettings(normalizeSettings(loadedSettings));
        setScreensaverState(overlay);
      } catch (error) {
        console.error(error);
      }

      unlistenScreensaver = await listen<ScreensaverState>(
        "screensaver://state",
        (event) => {
          setScreensaverState(event.payload);
        },
      );

      unlistenSettings = await listen<Partial<Settings>>(
        "settings://changed",
        (event) => {
          setSettings(normalizeSettings(event.payload));
        },
      );
    }

    boot();

    return () => {
      unlistenScreensaver?.();
      unlistenSettings?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = settings.locale;
  }, [settings.locale]);

  useEffect(() => {
    if (isScreensaver) {
      return;
    }

    let cancelled = false;

    async function checkForUpdates() {
      try {
        const next = await checkForAvailableUpdate();

        if (!cancelled) {
          setUpdateInfo(next);
        }
      } catch (error) {
        console.error(error);
      }
    }

    void checkForUpdates();

    return () => {
      cancelled = true;
    };
  }, [isScreensaver]);

  const saveSettings = useCallback(
    async (next: Settings) => {
      setSettings(next);
      setIsSaving(true);

      try {
        const saved = await invoke<Settings>("save_settings", {
          settings: next,
        });
        setSettings(normalizeSettings(saved));
        await refreshScreensaverState();
      } catch (error) {
        console.error(error);
      } finally {
        setIsSaving(false);
      }
    },
    [refreshScreensaverState],
  );

  const preview = useCallback(async () => {
    await invoke("preview_screensaver");
    await refreshScreensaverState();
  }, [refreshScreensaverState]);

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      await invoke("plugin:opener|open_url", {
        url,
        with: null,
      });
    } catch (error) {
      console.error(error);
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, []);

  const openGitHub = useCallback(async () => {
    await openExternalUrl(GITHUB_URL);
  }, [openExternalUrl]);

  const openUpdate = useCallback(async () => {
    if (updateInfo) {
      await openExternalUrl(updateInfo.url);
    }
  }, [openExternalUrl, updateInfo]);

  if (isScreensaver) {
    return <ScreensaverView LL={LL} state={screensaverState} />;
  }

  return (
    <main className="settings-shell" data-locale={settings.locale}>
      <section className="settings-panel" aria-labelledby="settings-title">
        <header className="settings-header">
          <img
            alt=""
            aria-hidden="true"
            className="settings-title-icon"
            src={appLogo}
          />
          <h1 className="settings-title" id="settings-title">
            Kitty Screen
          </h1>
        </header>

        {updateInfo && (
          <UpdateNotice LL={LL} info={updateInfo} onOpen={openUpdate} />
        )}

        <OptionGroup
          id="delay"
          label={LL.settings.delayLabel()}
          onChange={(delaySeconds) =>
            saveSettings({ ...settings, delaySeconds })
          }
          options={delayChoices}
          value={settings.delaySeconds}
        />

        <OptionGroup
          id="duration"
          label={LL.settings.durationLabel()}
          onChange={(durationSeconds) =>
            saveSettings({ ...settings, durationSeconds })
          }
          options={durationChoices}
          value={settings.durationSeconds}
        />

        <OptionGroup
          id="language"
          label={LL.settings.languageLabel()}
          onChange={(locale) => saveSettings({ ...settings, locale })}
          options={languageChoices}
          value={settings.locale}
          variant="language"
        />

        <footer className="settings-footer">
          <div className="settings-actions">
            <Button
              disabled={isSaving}
              onClick={preview}
              size="lg"
              variant="warning"
            >
              <Play aria-hidden="true" />
              {LL.settings.preview()}
            </Button>
            <Button onClick={openGitHub} size="lg" variant="secondary">
              <ExternalLink aria-hidden="true" />
              {LL.settings.github()}
            </Button>
          </div>
        </footer>
      </section>
      <p className="settings-credit">{LL.settings.credit()}</p>
    </main>
  );
}

function UpdateNotice({
  LL,
  info,
  onOpen,
}: {
  LL: TranslationFunctions;
  info: UpdateInfo;
  onOpen: () => void;
}) {
  return (
    <section className="update-notice" aria-live="polite">
      <div className="update-notice__copy">
        <strong>
          {LL.settings.updateAvailable()} {info.version}
        </strong>
        <span>{LL.settings.updateDescription()}</span>
      </div>
      <div className="update-notice__actions">
        <Button
          aria-label={String(LL.settings.updateOpen())}
          onClick={onOpen}
          size="icon"
          variant="success"
        >
          <ExternalLink aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}

function ScreensaverView({
  LL,
  state,
}: {
  LL: TranslationFunctions;
  state: ScreensaverState;
}) {
  const [showClock, setShowClock] = useState(false);
  const [videoSource, setVideoSource] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isReplayingLoopRef = useRef(false);
  const target = useMemo(() => {
    if (state.endsAtMs > Date.now()) {
      return state.endsAtMs;
    }

    return Date.now() + 1000;
  }, [state.endsAtMs, state.generation]);

  useEffect(() => {
    let cancelled = false;

    async function loadVideoSource() {
      try {
        const path = await resolveResource(screensaverVideoResourcePath());

        if (!cancelled) {
          setVideoSource(convertFileSrc(path));
        }
      } catch (error) {
        console.error(error);
      }
    }

    void loadVideoSource();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;

    setShowClock(false);
    isReplayingLoopRef.current = false;

    if (!state.isShowing) {
      video?.pause();

      if (video) {
        video.currentTime = 0;
      }

      return;
    }

    if (video && videoSource) {
      video.currentTime = 0;
      void video.play().catch((error: unknown) => {
        console.error(error);
      });
    }

    const timer = window.setTimeout(() => {
      setShowClock(true);
    }, CLOCK_REVEAL_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [state.generation, state.isShowing, videoSource]);

  const close = useCallback(async () => {
    try {
      await invoke("hide_screensaver");
    } catch (error) {
      console.error(error);
    }
  }, []);

  const replayLoop = useCallback(() => {
    const video = videoRef.current;

    if (!video || isReplayingLoopRef.current) {
      return;
    }

    isReplayingLoopRef.current = true;
    video.currentTime = LOOP_REPLAY_START_SECONDS;

    void video.play().catch((error: unknown) => {
      console.error(error);
    });
  }, []);

  const replayLoopBeforeEnd = useCallback(() => {
    const video = videoRef.current;

    if (
      !video ||
      video.seeking ||
      isReplayingLoopRef.current ||
      !Number.isFinite(video.duration)
    ) {
      return;
    }

    if (
      video.currentTime > LOOP_REPLAY_START_SECONDS + 1 &&
      video.duration - video.currentTime <= LOOP_REPLAY_END_PADDING_SECONDS
    ) {
      replayLoop();
    }
  }, [replayLoop]);

  return (
    <main className="screensaver">
      <video
        ref={videoRef}
        aria-hidden="true"
        className="screensaver__video"
        data-active="true"
        muted
        onEnded={replayLoop}
        onSeeked={() => {
          isReplayingLoopRef.current = false;
        }}
        onTimeUpdate={replayLoopBeforeEnd}
        playsInline
        preload="auto"
        src={videoSource ?? undefined}
      />
      <section className="screensaver__content" data-visible={showClock}>
        <FlipClockCountdown
          key={`${state.generation}-${target}`}
          className="kitty-countdown"
          digitBlockStyle={{
            background: "#fbfaf1",
            borderRadius: 0,
            boxShadow: "0 0 0 2px #101014, 0 5px 0 rgba(16, 16, 20, 0.55)",
            color: "#101014",
            fontFamily:
              '"Press Start 2P", ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: "clamp(30px, 4vw, 58px)",
            height: "clamp(68px, 8vw, 116px)",
            width: "clamp(50px, 6vw, 90px)",
          }}
          dividerStyle={{ color: "#101014", height: 1 }}
          duration={0.55}
          hideOnComplete={false}
          labelStyle={{
            color: "#fbfaf1",
            fontFamily:
              '"Press Start 2P", ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 9,
            textTransform: "uppercase",
          }}
          labels={["D", "H", "M", "S"]}
          onComplete={close}
          renderMap={[false, false, true, true]}
          separatorStyle={{
            color: "#fbfaf1",
            size: "clamp(13px, 1.8vw, 24px)",
          }}
          showLabels={false}
          spacing={{ clock: 16, digitBlock: 7 }}
          to={target}
        />
      </section>
      <Button
        aria-label={String(LL.screensaver.close())}
        className="screensaver__close"
        onClick={close}
        size="icon"
        variant="destructive"
      >
        <Power aria-hidden="true" />
      </Button>
    </main>
  );
}

export default App;
