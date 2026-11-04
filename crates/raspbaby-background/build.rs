fn main() {
    tauri_plugin::Builder::new(&["start", "stop", "status", "heartbeat"])
        .android_path("android")
        .build();
}
