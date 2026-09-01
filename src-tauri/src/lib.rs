/// PSForge - Modern PowerShell Editor
/// Main library module that registers all Tauri commands and plugins.
pub mod ai;
pub mod ai_cli;
pub mod ai_codex;
pub mod ai_cursor;
pub mod ai_ollama;
pub mod ai_opencode;
pub mod ai_opencode_list;
pub mod commands;
pub mod errors;
pub mod powershell;
pub mod ps_analyze;
pub mod ps_invoke;
pub mod ps_pssa_install;
pub mod settings;
#[cfg(not(test))]
pub mod terminal;
pub mod utils;
pub mod win_compat;
pub mod windows_terminal;

#[cfg(not(test))]
use log::{info, warn};
#[cfg(not(test))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Listener, Manager, WindowEvent,
};

#[derive(Debug, PartialEq, Eq)]
enum WindowCloseAction {
    HideToTray,
    Ignore,
}

fn window_close_action(is_close_requested: bool) -> WindowCloseAction {
    if is_close_requested {
        WindowCloseAction::HideToTray
    } else {
        WindowCloseAction::Ignore
    }
}

#[cfg(not(test))]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Exit via the frontend so it can flush debounced state (settings) that
/// would otherwise be lost — `app.exit()` skips the window-close path where
/// that flush normally runs. A watchdog force-exits if the webview is dead
/// or never responds.
#[cfg(not(test))]
fn request_exit(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if app.get_webview_window("main").is_some() && app.emit("psforge-exit-requested", ()).is_ok() {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            warn!("Frontend did not exit within 2s of tray Exit; forcing exit");
            handle.exit(0);
        });
    } else {
        app.exit(0);
    }
}

/// WebKitGTK's DMA-BUF renderer aborts the web process on several Wayland
/// compositors — under Hyprland with the NVIDIA driver the window dies with
/// "Error 71 (Protocol error) dispatching to Wayland display" before PSForge
/// paints anything. Fall back to the plain GL renderer, but never overwrite an
/// explicit choice, so `WEBKIT_DISABLE_DMABUF_RENDERER=0` still opts back in.
///
/// Must run before GTK/WebKit initialize, i.e. before the Tauri builder runs.
#[cfg(target_os = "linux")]
fn use_plain_gl_renderer_by_default() {
    if std::env::var_os(WEBKIT_DMABUF_ENV).is_none() {
        std::env::set_var(WEBKIT_DMABUF_ENV, "1");
    }
}

#[cfg(target_os = "linux")]
const WEBKIT_DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// Entry point for the Tauri application.
/// Registers all plugins and command handlers.
#[cfg(not(test))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    use_plain_gl_renderer_by_default();

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    info!("PSForge starting up");

    tauri::Builder::default()
        // Registered first so a second launch is intercepted before any other
        // initialization: it focuses the running instance's window and, when
        // the relaunch came from a file association, forwards the file path.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            info!("Second instance launch intercepted; focusing existing window");
            show_main_window(app);
            if let Some(path) = commands::launch_path_from_args(args) {
                use tauri::Emitter;
                let _ = app.emit("psforge-open-path", path);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() == "main"
                && window_close_action(matches!(event, WindowEvent::CloseRequested { .. }))
                    == WindowCloseAction::HideToTray
            {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::execute_script_debug,
            commands::prepare_terminal_script_command,
            commands::stop_script,
            commands::send_stdin,
            commands::debug_continue,
            commands::debug_step_over,
            commands::debug_step_into,
            commands::debug_step_out,
            commands::debug_set_frame,
            commands::get_script_parameters,
            commands::get_ps_versions,
            commands::get_installed_modules,
            commands::get_module_commands,
            commands::get_command_parameters,
            commands::get_command_help,
            commands::get_variables_after_run,
            commands::read_file_content,
            commands::save_file_content,
            commands::load_settings,
            commands::save_settings,
            commands::register_file_association,
            commands::unregister_file_association,
            commands::get_file_association_status,
            commands::batch_register_file_associations,
            commands::batch_unregister_file_associations,
            commands::register_context_menu,
            commands::unregister_context_menu,
            commands::get_context_menu_status,
            commands::get_snippets,
            commands::save_user_snippets,
            commands::reveal_in_explorer,
            ps_analyze::analyze_script,
            ps_pssa_install::check_psscriptanalyzer,
            ps_pssa_install::install_psscriptanalyzer,
            commands::get_completions,
            commands::suggest_modules_for_command,
            commands::get_execution_policy,
            commands::set_execution_policy,
            commands::get_launch_path,
            commands::format_script,
            commands::get_ps_profile_path,
            commands::get_scratch_dir,
            commands::list_scratch_files,
            commands::delete_scratch_file,
            commands::get_signing_certificates,
            commands::sign_script,
            ai::ask_ai,
            ai::list_ai_models,
            terminal::start_terminal,
            terminal::terminal_write,
            terminal::terminal_exec,
            terminal::stage_terminal_run_prep,
            terminal::terminal_resize,
            terminal::stop_terminal,
            windows_terminal::read_windows_terminal_settings,
        ])
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "Show PSForge", true, None::<&str>)?;
            let exit_item = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &exit_item])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("PSForge")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "exit" => request_exit(app),
                    _ => {}
                })
                // Left-click restores the window on Windows/macOS. Linux
                // appindicators never emit click events, so there the menu's
                // Show item is the only restore path.
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            } else {
                // Only reachable if the bundle icon list is emptied; without
                // an icon the tray entry is invisible on Linux.
                warn!("No default window icon; tray icon will be blank");
            }
            tray.build(app)?;

            // Stale temp file cleanup runs off the main thread so a slow tmpfs
            // (network share, encrypted volume) cannot delay window display.
            tauri::async_runtime::spawn_blocking(|| match utils::cleanup_psforge_temp_files() {
                Ok(removed) if removed > 0 => {
                    info!("Removed {} stale PSForge temp file(s)", removed);
                }
                Ok(_) => {}
                Err(err) => {
                    warn!("Failed to clean up stale PSForge temp files: {}", err);
                }
            });

            // Window starts hidden (`visible: false` in tauri.conf.json) to
            // prevent the white flash that occurs when the OS window appears
            // before the WebView has rendered. The frontend emits
            // `psforge-ready` after first mount; we show the window in
            // response so we never depend on a hard-coded delay (which is
            // either too short on slow boxes or wastes time on fast ones).
            let handle = app.handle().clone();
            let listener_handle = handle.clone();
            let listener_id = listener_handle.listen("psforge-ready", move |_event| {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            });

            // Safety net: if the WebView fails to load or the JS bundle never
            // boots (extreme: corrupt install), reveal the window after a
            // generous timeout so the user is never stuck staring at nothing.
            let safety_handle = listener_handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                if let Some(win) = safety_handle.get_webview_window("main") {
                    if !win.is_visible().unwrap_or(false) {
                        warn!("WebView did not signal ready within 3s; revealing window anyway");
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                safety_handle.unlisten(listener_id);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| match event {
            tauri::RunEvent::Exit => {
                // Kill a persistent host that is still mid-script (S6-19);
                // idle hosts self-terminate when their stdin pipe closes.
                tauri::async_runtime::block_on(commands::kill_active_run_on_exit());
            }
            // macOS: Dock icon clicked while the window is hidden in the tray.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(_app_handle),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_request_is_routed_to_the_system_tray() {
        assert_eq!(window_close_action(true), WindowCloseAction::HideToTray);
    }

    #[test]
    fn unrelated_window_events_are_ignored() {
        assert_eq!(window_close_action(false), WindowCloseAction::Ignore);
    }

    /// Single test for both branches: the environment is process-global, so
    /// splitting this in two would let the cases race each other.
    #[cfg(target_os = "linux")]
    #[test]
    fn dmabuf_renderer_is_disabled_unless_the_user_chose_a_value() {
        let restore = std::env::var_os(WEBKIT_DMABUF_ENV);

        std::env::remove_var(WEBKIT_DMABUF_ENV);
        use_plain_gl_renderer_by_default();
        assert_eq!(
            std::env::var(WEBKIT_DMABUF_ENV).as_deref(),
            Ok("1"),
            "an unset renderer variable must fall back to plain GL"
        );

        std::env::set_var(WEBKIT_DMABUF_ENV, "0");
        use_plain_gl_renderer_by_default();
        assert_eq!(
            std::env::var(WEBKIT_DMABUF_ENV).as_deref(),
            Ok("0"),
            "an explicit opt-in to DMA-BUF must survive"
        );

        match restore {
            Some(value) => std::env::set_var(WEBKIT_DMABUF_ENV, value),
            None => std::env::remove_var(WEBKIT_DMABUF_ENV),
        }
    }
}
