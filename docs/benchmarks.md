# HQ server benchmarks

Measured on 2026-11-23, one 16-core Linux machine. Both servers ran in Docker with `--cpus 2 --memory 1g`. The load generators ran on the same machine, outside the containers (`scripts/load-http.mjs`, 4 processes of 64 keep-alive connections each, 10 seconds per run).

- **v1:** the Node 22 server (`arimaops:latest`).
- **v2:** the Rust server (release build of this repository) on Ubuntu 24.04.

| What | Node v1 | Rust v2 |
| --- | --- | --- |
| Memory at idle | 78 to 95 MiB | 3 MiB |
| `/api/health`, requests per second | 15,200 | 37,800 |
| `/api/health`, slowest 1% of requests | 37 ms | 14 ms |
| The web app's start page, requests per second | 5,900 | 37,100 |
| The web app's start page, slowest 1% | 59 ms | 14 ms |
| Memory while serving that load | 96 to 104 MiB | 9 to 11 MiB |
| Memory with 300 live browser connections | 105 MiB | 27 MiB |
| Time until all 300 connections got their first screen | 0.40 s | 0.48 s |
| Server image size | 3.5 GB (includes agent tooling) | 167 MB |

## What this does and does not say

- It is a synthetic test of the HQ server. Agents, models and the browser dominate what a person waits for, and none of that is measured here.
- One machine ran both the servers and the load, so absolute numbers will differ on other hardware. The ratios are the point.
- A single-process load generator tops out near 12,700 requests per second, which hid the difference at first. The table uses four processes.
- The 3.5 GB v1 image bundles agent tooling that the v2 server image does not, so image size is not a like-for-like comparison.
- Rust was not faster at opening 300 connections (0.40 s against 0.48 s).

## What the benchmark found and fixed

The first run of 300 live connections made the Rust server grow to 133 to 178 MiB, and it did not shrink afterwards. Each new connection built its own copy of the 53 KB starting snapshot, so 300 at once held 300 copies in memory, and each socket kept 256 KB of buffers. Two changes fixed it:

- The first screen for new connections is now built once and shared until something changes (any event clears it, and it never lives past 5 seconds).
- Per-socket buffers are 16 KiB instead of 128 KiB.

After that, 300 connections cost 27 MiB and stay there across repeated rounds. Swapping the memory allocator made no difference and was dropped.
