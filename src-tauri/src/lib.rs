//! SV Publisher - Tauri Application
//!
//! IEC 61850 Sampled Values Publisher with native C++ backend

#![allow(non_snake_case)]
#![allow(dead_code)]

mod ffi;
mod commands;

/* C++ WebSocket server — same pattern as the subscriber.
 * Spawns one background thread inside the publisher process. The hint port
 * is the START of a 100-port scan; the C++ side picks the first free slot
 * so multiple publisher instances each get their own port. */
extern "C" {
    fn sv_pub_ws_start(port_hint: u16) -> std::os::raw::c_int;
    fn sv_pub_ws_get_port() -> u16;
}

/// Initialize Npcap DLL path on Windows
fn init_npcap_path() {
    #[cfg(target_os = "windows")]
    {
        use std::env;
        if let Ok(current_path) = env::var("PATH") {
            let npcap_path = r"C:\Windows\System32\Npcap";
            if !current_path.contains(npcap_path) {
                env::set_var("PATH", format!("{};{}", npcap_path, current_path));
                println!("[init] Added Npcap to PATH: {}", npcap_path);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize Npcap DLL path before anything else
    init_npcap_path();

    /* Start the C++ WebSocket server BEFORE Tauri init.
     * - Runs in its own thread (uWS event loop), never blocks here.
     * - Available before the webview even loads the page.
     * - Survives even if GTK / window init fails (rare but useful for
     *   headless smoke-tests).
     *
     * sv_pub_ws_start scans [9100..9199] and binds the first free port,
     * so launching the binary multiple times gives each process its own
     * backend (its own PublisherController) — fixes the "all windows
     * show the same fleet" regression. */
    let rc = unsafe { sv_pub_ws_start(9100) };
    if rc != 0 {
        eprintln!("[publisher] FATAL: no WS port available in 9100..9199");
        std::process::exit(1);
    }
    let port: u16 = unsafe { sv_pub_ws_get_port() };
    println!("[publisher] WebSocket server bound to ws://localhost:{}/ws", port);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        /* No invoke_handler — the JS frontend talks to the C++ backend
         * directly over WebSocket (same pattern as the subscriber).
         * See native/src/PubWsServer.cc. */
        .setup(move |app| {
            println!("╔════════════════════════════════════════════════════════════╗");
            println!("║         SV PUBLISHER (Tauri + Rust + C++)                  ║");
            println!("╠════════════════════════════════════════════════════════════╣");
            println!("║  🚀 Application initialized                                ║");
            println!("║  🔌 Backend: WebSocket on localhost:{:<5} /ws                ║", port);
            println!("╚════════════════════════════════════════════════════════════╝");

            /* Inject the actual bound port into the webview BEFORE any
             * page JS runs so tauriClient.js can pick it up. eval queues
             * the script for execution at the next webview tick; the JS
             * side polls window.__PUB_WS_PORT__ briefly before falling
             * back to the historical 9100 default. */
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let script = format!(
                        "window.__PUB_WS_PORT__ = {}; \
                         console.log('[publisher] WS port injected:', {});",
                        port, port);
                    let _ = win.eval(&script);
                    win.open_devtools();
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
