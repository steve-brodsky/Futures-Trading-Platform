//! Run with `cargo run --locked --example webview_smoke` on Windows.
//! Exercises native WebView2 creation, resize/move messages, and teardown using
//! a hidden window and an isolated profile. No app commands or broker services.
#[cfg(target_os = "windows")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.northstar.webview-smoke".into();
    let app = tauri::Builder::default()
        .setup(|app| {
            let profile = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/webview-smoke")
                .join(uuid::Uuid::new_v4().to_string());
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "webview-smoke",
                tauri::WebviewUrl::External("about:blank".parse()?),
            )
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .data_directory(profile)
            .build()?;
            std::thread::spawn(move || {
                for index in 0..8 {
                    window
                        .set_size(tauri::PhysicalSize::new(800 + index, 600 + index))
                        .expect("resize smoke window");
                    window
                        .set_position(tauri::PhysicalPosition::new(index, index))
                        .expect("move smoke window");
                }
                window.close().expect("close smoke window");
            });
            Ok(())
        })
        .build(context)?;
    let exit_code = app.run_return(|_, _| {});
    assert_eq!(exit_code, 0, "WebView2 smoke process failed");
    println!("WebView2 create/resize/move/close smoke check passed");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn main() {
    println!("This smoke check exercises the Windows WebView2 runtime.");
}
