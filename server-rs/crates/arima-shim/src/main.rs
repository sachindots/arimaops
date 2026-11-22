// SPDX-License-Identifier: AGPL-3.0-or-later

//! Static container/sandbox agent shim binary for ArimaOps v2.0.

use std::collections::HashMap;
use std::env;
use std::io::{self, Read};
use std::path::PathBuf;

use arima_shim::{
    evaluate_stdio_hook_json, version_string, PermissionVerdict, PtyMultiplexer, ShimStateStore,
};
use tokio::sync::mpsc;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("{}", version_string());
        return;
    }

    match args.first().map(String::as_str) {
        Some("permission-hook") => {
            let mut input = String::new();
            if io::stdin().read_to_string(&mut input).is_ok() {
                let default_verdict = env::var("ARIMA_PERMISSION_DEFAULT")
                    .ok()
                    .and_then(|v| PermissionVerdict::parse(&v))
                    .unwrap_or(PermissionVerdict::Deny);
                match evaluate_stdio_hook_json(&input, default_verdict) {
                    Ok(json_out) => println!("{json_out}"),
                    Err(err) => {
                        eprintln!("arima-shim permission-hook error: {err}");
                        std::process::exit(1);
                    }
                }
            }
        }
        Some("run") => {
            let mut state_file = PathBuf::from(".arima-shim-state.json");
            let mut agent_id = String::from("agent");
            let mut program: Option<String> = None;
            let mut prog_args: Vec<String> = Vec::new();

            let mut idx = 1;
            while idx < args.len() {
                match args[idx].as_str() {
                    "--state-file" if idx + 1 < args.len() => {
                        state_file = PathBuf::from(&args[idx + 1]);
                        idx += 2;
                    }
                    "--agent" if idx + 1 < args.len() => {
                        agent_id = args[idx + 1].clone();
                        idx += 2;
                    }
                    "--program" if idx + 1 < args.len() => {
                        program = Some(args[idx + 1].clone());
                        idx += 2;
                    }
                    "--" => {
                        prog_args.extend_from_slice(&args[idx + 1..]);
                        break;
                    }
                    other => {
                        if program.is_none() {
                            program = Some(other.to_owned());
                        } else {
                            prog_args.push(other.to_owned());
                        }
                        idx += 1;
                    }
                }
            }

            let state = ShimStateStore::load_or_default(&state_file).unwrap_or_default();
            let _ = ShimStateStore::save_atomic(&state_file, &state);

            if let Some(prog) = program {
                let (tx, _rx) = mpsc::channel(64);
                let mux = PtyMultiplexer::new(agent_id, None, tx);
                match mux
                    .spawn_process(&prog, &prog_args, &HashMap::new(), None)
                    .await
                {
                    Ok(Some(code)) => std::process::exit(code),
                    Ok(None) => {}
                    Err(err) => {
                        eprintln!("arima-shim run error: {err}");
                        std::process::exit(1);
                    }
                }
            }
        }
        _ => {
            println!(
                "{}: usage: arima-shim [--version | run --state-file <path> --program <bin> | permission-hook]",
                version_string()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_package_version() {
        assert_eq!(
            version_string(),
            format!("arima-shim {}", env!("CARGO_PKG_VERSION"))
        );
    }
}
