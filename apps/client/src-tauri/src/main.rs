// SPDX-License-Identifier: AGPL-3.0-or-later

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    arima_client_lib::run();
}
