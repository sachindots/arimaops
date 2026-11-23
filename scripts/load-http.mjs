// Tiny HTTP load generator: N keep-alive connections hammer one URL for a fixed time, then print requests/s and latency percentiles.
// Usage: node load.mjs http://127.0.0.1:7655/api/health 64 10
import http from "node:http";

const [url, conns = "64", secs = "10"] = process.argv.slice(2);
const u = new URL(url);
const agent = new http.Agent({ keepAlive: true, maxSockets: Number(conns) });
const lat = [];
let errors = 0;
let non2xx = 0;
let bytes = 0;
const endAt = Date.now() + Number(secs) * 1000;

function one() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, agent }, (res) => {
      res.on("data", (c) => (bytes += c.length));
      res.on("end", () => {
        lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
        if (res.statusCode < 200 || res.statusCode >= 300) non2xx++;
        resolve();
      });
    });
    req.on("error", () => {
      errors++;
      resolve();
    });
  });
}

async function worker() {
  while (Date.now() < endAt) await one();
}

const start = Date.now();
await Promise.all(Array.from({ length: Number(conns) }, worker));
const took = (Date.now() - start) / 1000;
lat.sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;
console.log(JSON.stringify({ url, conns: Number(conns), reqPerSec: Math.round(lat.length / took), p50: +q(0.5).toFixed(2), p99: +q(0.99).toFixed(2), max: +q(1).toFixed(1), errors, non2xx, MBps: +(bytes / took / 1e6).toFixed(1) }));
process.exit(0);
