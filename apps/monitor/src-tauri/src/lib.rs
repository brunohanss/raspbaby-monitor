#[cfg(target_os = "windows")]
mod camera;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Register first: reopening the executable must restore the existing peer,
    // rather than start a second receiver or initialize its plugins.
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        windows::reopen(app);
    }));
    let builder = builder.plugin(tauri_plugin_background_monitor::init());
    #[cfg(target_os = "windows")]
    let builder = builder
        .manage(camera::CameraConnector::default())
        .setup(windows::setup)
        .on_window_event(windows::on_window_event)
        .invoke_handler(tauri::generate_handler![
            windows::minimize_window,
            windows::toggle_maximize_window,
            windows::hide_to_tray,
            windows::start_window_drag,
            windows::quit_app,
            camera::connect_camera,
            camera::disconnect_camera,
            camera::camera_session_status,
        ]);
    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build the Raspbaby application");
    app.run(|_app, _event| {
        #[cfg(target_os = "windows")]
        if let tauri::RunEvent::Exit = _event {
            _app.state::<camera::CameraConnector>().shutdown();
        }
    });
}
