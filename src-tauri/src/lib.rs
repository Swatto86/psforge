/// PSForge - Modern PowerShell Editor
/// Main library module that registers all Tauri commands and plugins.
pub mod commands;
pub mod errors;
pub mod powershell;
pub mod settings;
pub mod terminal;
pub mod utils;

use log::info;
use tauri::Manager;

/// Entry point for the Tauri application.
/// Registers all plugins and command handlers.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    info!("PSForge starting up");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::execute_script,
            commands::execute_script_debug,
            commands::execute_selection,
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
            commands::get_snippets,
            commands::save_user_snippets,
            commands::reveal_in_explorer,
            commands::analyze_script,
            commands::get_completions,
            commands::suggest_modules_for_command,
            commands::get_execution_policy,
            commands::set_execution_policy,
            commands::get_launch_path,
            commands::format_script,
            commands::get_ps_profile_path,
            commands::get_signing_certificates,
            commands::sign_script,
            terminal::start_terminal,
            terminal::terminal_write,
            terminal::terminal_exec,
            terminal::terminal_resize,
            terminal::stop_terminal,
        ])
        .setup(|app| {
            // Window starts hidden (`visible: false` in tauri.conf.json) to prevent the
            // white flash that occurs when the OS window appears before the WebView
            // has rendered. This setup hook reveals the window from the Rust side
            // (CSP-immune) after the WebView has had time to initialise.
            //
            // The complementary CSS `.psforge-loading` class (added by preload.js,
            // removed by React after first mount) provides FOUC protection within the
            // WebView while the JS bundle hydrates.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
