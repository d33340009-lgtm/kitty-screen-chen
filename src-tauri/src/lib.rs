use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, Wry,
};

const DELAY_OPTIONS: [u64; 6] = [15 * 60, 30 * 60, 60 * 60, 90 * 60, 120 * 60, 180 * 60];
const DURATION_OPTIONS: [u64; 10] = [15, 30, 60, 90, 120, 180, 300, 600, 900, 1800];
const DEFAULT_DELAY_SECONDS: u64 = 30 * 60;
const DEFAULT_DURATION_SECONDS: u64 = 30;
const DEFAULT_LOCALE: &str = "zh-CN";
const PREVIEW_SECONDS: u64 = 30;
const LOCALE_OPTIONS: [&str; 9] = [
    "en", "zh-CN", "zh-HK", "zh-TW", "ja", "ko", "es", "fr", "pt",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    delay_seconds: u64,
    duration_seconds: u64,
    locale: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            delay_seconds: DEFAULT_DELAY_SECONDS,
            duration_seconds: DEFAULT_DURATION_SECONDS,
            locale: DEFAULT_LOCALE.to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreensaverState {
    is_showing: bool,
    duration_seconds: u64,
    ends_at_ms: u64,
    mode: String,
    generation: u64,
}

impl Default for ScreensaverState {
    fn default() -> Self {
        Self {
            is_showing: false,
            duration_seconds: DEFAULT_DURATION_SECONDS,
            ends_at_ms: 0,
            mode: "scheduled".to_string(),
            generation: 0,
        }
    }
}

struct AppState {
    settings: Mutex<Settings>,
    screensaver: Mutex<ScreensaverState>,
    display_on_since: Mutex<Instant>,
    open_app_item: Mutex<Option<MenuItem<Wry>>>,
    toggle_item: Mutex<Option<MenuItem<Wry>>>,
    quit_item: Mutex<Option<MenuItem<Wry>>>,
}

impl AppState {
    fn new(settings: Settings) -> Self {
        Self {
            settings: Mutex::new(settings),
            screensaver: Mutex::new(ScreensaverState::default()),
            display_on_since: Mutex::new(Instant::now()),
            open_app_item: Mutex::new(None),
            toggle_item: Mutex::new(None),
            quit_item: Mutex::new(None),
        }
    }
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state
        .settings
        .lock()
        .expect("settings lock poisoned")
        .clone()
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    let settings = validate_settings(settings);
    {
        let mut current = state.settings.lock().map_err(|error| error.to_string())?;
        *current = settings.clone();
    }

    persist_settings(&app, settings.clone())?;
    update_tray_labels(&app);
    emit_settings(&app);
    Ok(settings)
}

#[tauri::command]
fn get_screensaver_state(state: State<'_, AppState>) -> ScreensaverState {
    state
        .screensaver
        .lock()
        .expect("screensaver lock poisoned")
        .clone()
}

#[tauri::command]
fn preview_screensaver(app: AppHandle) -> Result<(), String> {
    show_screensaver(&app, PREVIEW_SECONDS, "preview")
}

#[tauri::command]
fn hide_screensaver(app: AppHandle) -> Result<(), String> {
    hide_screensaver_inner(&app)
}

fn validate_settings(settings: Settings) -> Settings {
    let locale = if LOCALE_OPTIONS.contains(&settings.locale.as_str()) {
        settings.locale
    } else {
        DEFAULT_LOCALE.to_string()
    };

    Settings {
        delay_seconds: if DELAY_OPTIONS.contains(&settings.delay_seconds) {
            settings.delay_seconds
        } else {
            DEFAULT_DELAY_SECONDS
        },
        duration_seconds: if DURATION_OPTIONS.contains(&settings.duration_seconds) {
            settings.duration_seconds
        } else {
            DEFAULT_DURATION_SECONDS
        },
        locale,
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };

    let Ok(contents) = fs::read_to_string(path) else {
        return Settings::default();
    };

    serde_json::from_str::<Settings>(&contents)
        .map(validate_settings)
        .unwrap_or_default()
}

fn persist_settings(app: &AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let json = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn create_screensaver_window(app: &mut tauri::App) -> tauri::Result<()> {
    let initial_bounds = initial_overlay_logical_bounds(app)?;
    let mut builder = WebviewWindowBuilder::new(
        app,
        "screensaver",
        WebviewUrl::App("index.html?screensaver".into()),
    )
    .title("Kitty Screen")
    .decorations(false)
    .fullscreen(false)
    .always_on_top(true)
    .transparent(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .shadow(false)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false);

    if let Some((x, y, width, height)) = initial_bounds {
        builder = builder.position(x, y).inner_size(width, height);
    }

    let window = builder.build()?;

    apply_transparent_screensaver_background(&window)?;

    Ok(())
}

fn initial_overlay_logical_bounds(app: &tauri::App) -> tauri::Result<Option<(f64, f64, f64, f64)>> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or(app.primary_monitor()?);
    let Some(monitor) = monitor else {
        return Ok(None);
    };

    let work_area = monitor.work_area();
    let position = work_area.position;
    let size = work_area.size;
    let scale_factor = monitor.scale_factor().max(1.0);

    Ok(Some((
        f64::from(position.x) / scale_factor,
        f64::from(position.y) / scale_factor,
        f64::from(size.width) / scale_factor,
        f64::from(size.height) / scale_factor,
    )))
}

fn apply_transparent_screensaver_background(window: &WebviewWindow) -> tauri::Result<()> {
    window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))
}

fn setup_main_window(app: &AppHandle) {
    if let Some(main_window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        let app_handle = app.clone();
        let window_to_hide = main_window.clone();

        main_window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window_to_hide.hide();

                #[cfg(target_os = "macos")]
                let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        });
    }
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|error| error.to_string())?;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let locale = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|settings| settings.locale.clone())
        .unwrap_or_else(|_| DEFAULT_LOCALE.to_string());
    let labels = tray_labels(&locale);
    let open_app_item = MenuItem::with_id(app, "open_app", labels.open_app, true, None::<&str>)?;
    let toggle_item =
        MenuItem::with_id(app, "toggle_screensaver", labels.show, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_app_item, &toggle_item, &quit_item])?;
    let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

    {
        let state = app.state::<AppState>();
        state
            .open_app_item
            .lock()
            .expect("open app item lock poisoned")
            .replace(open_app_item);
        state
            .toggle_item
            .lock()
            .expect("toggle item lock poisoned")
            .replace(toggle_item);
        state
            .quit_item
            .lock()
            .expect("quit item lock poisoned")
            .replace(quit_item);
    }

    let tray = TrayIconBuilder::with_id("kitty-screen")
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Kitty Screen")
        .on_menu_event(|app, event| {
            let app = app.clone();
            let id = event.id().as_ref().to_string();

            tauri::async_runtime::spawn(async move {
                match id.as_str() {
                    "open_app" => {
                        let _ = show_main_window(&app);
                    }
                    "toggle_screensaver" => {
                        let _ = toggle_screensaver(&app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                }
            });
        });

    tray.build(app)?;
    Ok(())
}

fn toggle_screensaver(app: &AppHandle) -> Result<(), String> {
    let is_showing = {
        let state = app.state::<AppState>();
        let screensaver = state
            .screensaver
            .lock()
            .map_err(|error| error.to_string())?;
        screensaver.is_showing
    };

    if is_showing {
        hide_screensaver_inner(app)
    } else {
        let duration_seconds = {
            let state = app.state::<AppState>();
            let settings = state.settings.lock().map_err(|error| error.to_string())?;
            settings.duration_seconds
        };
        show_screensaver(app, duration_seconds, "manual")
    }
}

fn show_screensaver(app: &AppHandle, duration_seconds: u64, mode: &str) -> Result<(), String> {
    let generation = {
        let state = app.state::<AppState>();
        let mut screensaver = state
            .screensaver
            .lock()
            .map_err(|error| error.to_string())?;

        screensaver.is_showing = true;
        screensaver.duration_seconds = duration_seconds;
        screensaver.ends_at_ms = now_ms().saturating_add(duration_seconds.saturating_mul(1000));
        screensaver.mode = mode.to_string();
        screensaver.generation = screensaver.generation.saturating_add(1);
        screensaver.generation
    };

    let window = app
        .get_webview_window("screensaver")
        .ok_or_else(|| "screensaver window not found".to_string())?;

    window
        .set_decorations(false)
        .map_err(|error| error.to_string())?;
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    let _ = window.set_shadow(false);
    let _ = window.set_visible_on_all_workspaces(true);
    window
        .set_fullscreen(false)
        .map_err(|error| error.to_string())?;
    apply_transparent_screensaver_background(&window).map_err(|error| error.to_string())?;
    place_foremost_overlay(app, &window)?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;

    update_tray_labels(app);
    emit_screensaver_state(app);
    schedule_auto_hide(app.clone(), generation, duration_seconds);
    Ok(())
}

fn place_foremost_overlay(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or(app.primary_monitor().map_err(|error| error.to_string())?)
        .or_else(|| window.current_monitor().ok().flatten())
        .ok_or_else(|| "no monitor available for screensaver window".to_string())?;

    let work_area = monitor.work_area();
    let position = work_area.position;
    let size = work_area.size;

    window
        .set_position(PhysicalPosition::new(position.x, position.y))
        .map_err(|error| error.to_string())?;
    window
        .set_size(PhysicalSize::new(size.width, size.height))
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn hide_screensaver_inner(app: &AppHandle) -> Result<(), String> {
    let should_reset_tracking = {
        let state = app.state::<AppState>();
        let mut screensaver = state
            .screensaver
            .lock()
            .map_err(|error| error.to_string())?;

        if !screensaver.is_showing {
            return Ok(());
        }

        let should_reset = screensaver.mode != "preview";
        screensaver.is_showing = false;
        screensaver.ends_at_ms = 0;
        screensaver.generation = screensaver.generation.saturating_add(1);
        should_reset
    };

    if let Some(window) = app.get_webview_window("screensaver") {
        let _ = window.hide();
    }

    if should_reset_tracking {
        reset_display_tracking(app);
    }

    update_tray_labels(app);
    emit_screensaver_state(app);
    Ok(())
}

fn schedule_auto_hide(app: AppHandle, generation: u64, duration_seconds: u64) {
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(duration_seconds));

        let should_hide = {
            let state = app.state::<AppState>();
            state
                .screensaver
                .lock()
                .map(|screensaver| screensaver.is_showing && screensaver.generation == generation)
                .unwrap_or(false)
        };

        if should_hide {
            let _ = hide_screensaver_inner(&app);
        }
    });
}

fn emit_screensaver_state(app: &AppHandle) {
    let payload = {
        let state = app.state::<AppState>();
        state
            .screensaver
            .lock()
            .map(|screensaver| screensaver.clone())
            .unwrap_or_default()
    };

    let _ = app.emit("screensaver://state", payload);
}

fn emit_settings(app: &AppHandle) {
    let payload = {
        let state = app.state::<AppState>();
        state
            .settings
            .lock()
            .map(|settings| settings.clone())
            .unwrap_or_default()
    };

    let _ = app.emit("settings://changed", payload);
}

struct TrayLabels {
    open_app: &'static str,
    show: &'static str,
    hide: &'static str,
    quit: &'static str,
}

fn tray_labels(locale: &str) -> TrayLabels {
    match locale {
        "en" => TrayLabels {
            open_app: "Open App",
            show: "Show now",
            hide: "Close now",
            quit: "Quit",
        },
        "zh-HK" => TrayLabels {
            open_app: "開啟 App",
            show: "立即顯示",
            hide: "立即關閉",
            quit: "退出",
        },
        "zh-TW" => TrayLabels {
            open_app: "開啟 App",
            show: "立即顯示",
            hide: "立即關閉",
            quit: "退出",
        },
        "ja" => TrayLabels {
            open_app: "アプリを開く",
            show: "今すぐ表示",
            hide: "今すぐ閉じる",
            quit: "終了",
        },
        "ko" => TrayLabels {
            open_app: "앱 열기",
            show: "지금 표시",
            hide: "지금 닫기",
            quit: "종료",
        },
        "es" => TrayLabels {
            open_app: "Abrir app",
            show: "Mostrar ahora",
            hide: "Cerrar ahora",
            quit: "Salir",
        },
        "fr" => TrayLabels {
            open_app: "Ouvrir l'app",
            show: "Afficher",
            hide: "Fermer",
            quit: "Quitter",
        },
        "pt" => TrayLabels {
            open_app: "Abrir app",
            show: "Mostrar agora",
            hide: "Fechar agora",
            quit: "Sair",
        },
        _ => TrayLabels {
            open_app: "打开 App",
            show: "立即显示",
            hide: "立即关闭",
            quit: "退出",
        },
    }
}

fn update_tray_labels(app: &AppHandle) {
    let (is_showing, locale, open_app_item, toggle_item, quit_item) = {
        let state = app.state::<AppState>();
        let locale = state
            .settings
            .lock()
            .map(|settings| settings.locale.clone())
            .unwrap_or_else(|_| DEFAULT_LOCALE.to_string());
        let is_showing = state
            .screensaver
            .lock()
            .map(|screensaver| screensaver.is_showing)
            .unwrap_or(false);
        let open_app_item = state
            .open_app_item
            .lock()
            .ok()
            .and_then(|item| item.as_ref().cloned());
        let toggle_item = state
            .toggle_item
            .lock()
            .ok()
            .and_then(|item| item.as_ref().cloned());
        let quit_item = state
            .quit_item
            .lock()
            .ok()
            .and_then(|item| item.as_ref().cloned());
        (is_showing, locale, open_app_item, toggle_item, quit_item)
    };

    let labels = tray_labels(&locale);

    if let Some(item) = open_app_item {
        let _ = item.set_text(labels.open_app);
    }

    if let Some(item) = toggle_item {
        let text = if is_showing { labels.hide } else { labels.show };
        let _ = item.set_text(text);
    }

    if let Some(item) = quit_item {
        let _ = item.set_text(labels.quit);
    }
}

fn reset_display_tracking(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(mut display_on_since) = state.display_on_since.lock() {
        *display_on_since = Instant::now();
    };
}

fn start_display_monitor(app: AppHandle) {
    thread::spawn(move || {
        let mut was_display_on = display_is_on();

        if !was_display_on {
            reset_display_tracking(&app);
        }

        loop {
            thread::sleep(Duration::from_secs(2));

            let display_on = display_is_on();
            if !display_on {
                if was_display_on {
                    reset_display_tracking(&app);
                    let _ = hide_screensaver_inner(&app);
                }
                was_display_on = false;
                continue;
            }

            if !was_display_on {
                reset_display_tracking(&app);
                was_display_on = true;
            }

            let (delay_seconds, duration_seconds, elapsed, is_showing) = {
                let state = app.state::<AppState>();

                let Ok((delay_seconds, duration_seconds)) = state
                    .settings
                    .lock()
                    .map(|settings| (settings.delay_seconds, settings.duration_seconds))
                else {
                    continue;
                };
                let Ok(elapsed) = state
                    .display_on_since
                    .lock()
                    .map(|display_on_since| display_on_since.elapsed())
                else {
                    continue;
                };
                let Ok(is_showing) = state
                    .screensaver
                    .lock()
                    .map(|screensaver| screensaver.is_showing)
                else {
                    continue;
                };

                (delay_seconds, duration_seconds, elapsed, is_showing)
            };

            if !is_showing && elapsed >= Duration::from_secs(delay_seconds) {
                let _ = show_screensaver(&app, duration_seconds, "scheduled");
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn display_is_on() -> bool {
    let Ok(output) = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-lw0", "-c", "IODisplayWrangler"])
        .output()
    else {
        return true;
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let marker = "\"CurrentPowerState\"=";
    let Some(index) = text.find(marker) else {
        return true;
    };

    let value = text[index + marker.len()..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();

    value.parse::<u64>().map(|state| state >= 2).unwrap_or(true)
}

#[cfg(not(target_os = "macos"))]
fn display_is_on() -> bool {
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let settings = load_settings(app.handle());
            app.manage(AppState::new(settings));
            setup_main_window(app.handle());
            create_screensaver_window(app)?;
            setup_tray(app)?;
            start_display_monitor(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_screensaver_state,
            preview_screensaver,
            hide_screensaver
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
