// SPDX-License-Identifier: AGPL-3.0-or-later

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_dist = manifest_dir.join("../../../dist");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));

    println!("cargo:rerun-if-changed={}", repo_dist.display());
    println!("cargo:rerun-if-changed={}", repo_dist.join("index.html").display());

    if repo_dist.join("index.html").is_file() {
        let canonical = fs::canonicalize(&repo_dist).unwrap_or(repo_dist);
        println!("cargo:rustc-env=ARIMA_DIST_DIR={}", canonical.display());
    } else {
        let empty = out_dir.join("empty-dist");
        let _ = fs::create_dir_all(&empty);
        println!("cargo:rustc-env=ARIMA_DIST_DIR={}", empty.display());
    }
}
