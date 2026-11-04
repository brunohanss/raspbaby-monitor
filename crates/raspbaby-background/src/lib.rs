//! The Android foreground service supports the existing WebView receiver.
//! It does not own media and cannot recover a destroyed WebView.

use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("background-monitor")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("org.raspbaby.background", "BackgroundMonitorPlugin")?;
            Ok(())
        })
        .build()
}
