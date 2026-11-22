# ArimaOps Unified Client (Tauri v2 — Linux, macOS, Windows & Android)

Thin multi-server desktop and mobile client for ArimaOps v2.0 built with **Tauri v2** as its own standalone Cargo workspace (`apps/client/src-tauri/Cargo.toml`), keeping the Rust HQ server workspace (`server-rs/`) completely free of GUI/WebKit dependencies.

## Features
- **Multi-Server Picker (`apps/client/ui/index.html`):** Add, edit, and delete saved ArimaOps HQ servers (e.g. `Local HQ` at `http://localhost:7420` and `AWS Production` at `https://hq.yourdomain.com`) with live `/api/health` reachability & version badges.
- **Hardened Profile Persistence (`src-tauri/src/profiles.rs`):** Atomic `0600` JSON store in the OS app config directory with strict `http://` / `https://` URL validation (rejecting `javascript:`, `file:`, `data:`, and embedded credentials).
- **1-Click Server Switching:** Desktop system tray (`Open ArimaOps`, `Switch Server`, `Quit`) plus `window.__TAURI_INTERNALS__.invoke("switch_server")` bridge integrated into ArimaOps's `SignIn` screen and user menu.
- **Single Codebase for Desktop + Android:** Uses `#[cfg_attr(mobile, tauri::mobile_entry_point)]` so Linux, macOS, Windows, and Android share one Rust core.

> Note: Legacy `android/` remains untouched until the Tauri v2 Android APK is verified on physical devices.

## Local Development & Verification

```bash
# Run unit tests and clippy on the standalone client workspace:
cargo test --manifest-path apps/client/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/client/src-tauri/Cargo.toml --all-targets -- -D warnings

# Run desktop client locally (requires tauri-cli: `cargo install tauri-cli --version "^2"`):
cd apps/client
cargo tauri dev

# Build desktop installers (.AppImage/.deb on Linux, .dmg on macOS, .msi/.exe on Windows):
cargo tauri build

# Initialize and build Android APK (requires Android SDK/NDK + Rust Android targets):
cargo tauri android init
cargo tauri android build --apk
```
