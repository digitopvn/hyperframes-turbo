/** Host-safety guard: the sampler watchdog must tell a blocked harness from a dead sampler (Windows only). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_LIMITS, descendantsOf, killTree, MAX_SILENCE_LIMIT_MS, ProcessGuard, type AbortInfo } from "../src/process-guard.js";

const permissive = { ...DEFAULT_LIMITS, minFreeRamBytes: 0, minFreeRamFraction: 0, maxCommitFraction: 1, maxChrome: 10_000 };
const win = process.platform === "win32";

test("descendantsOf walks the whole tree from a ps listing, parents first", () => {
  const ps = ["  1     0", " 10     1", " 11    10", " 12    10", " 13    11", " 20     1", " 99    99", "garbage"].join("\n");
  assert.deepEqual(descendantsOf(10, ps), [10, 11, 12, 13]);
  assert.deepEqual(descendantsOf(13, ps), [13]);
  assert.deepEqual(descendantsOf(404, ps), [404]);
});

test("killTree kills grandchildren, not only the root", { timeout: 30_000 }, async () => {
  const { spawn } = await import("node:child_process");
  // root -> child -> grandchild, each a plain Node process that idles.
  const idle = "setInterval(()=>{},1e6)";
  const grand = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(idle)}],{stdio:'ignore',windowsHide:true}).pid`;
  const childSrc = `const g=${grand};process.stdout.write(String(g)+'\\n');${idle}`;
  const rootSrc = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childSrc)}],{stdio:['ignore','pipe','ignore'],windowsHide:true});c.stdout.pipe(process.stdout);process.stdout.write(String(c.pid)+'\\n');${idle}`;
  const root = spawn(process.execPath, ["-e", rootSrc], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const pids = await new Promise<number[]>((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new Error("tree did not start")), 20_000);
    root.stdout!.setEncoding("utf8");
    root.stdout!.on("data", (c: string) => {
      buf += c;
      const got = buf.split("\n").filter(Boolean).map(Number);
      if (got.length >= 2) {
        clearTimeout(t);
        res(got);
      }
    });
  });
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  const all = [root.pid!, ...pids];
  try {
    assert.ok(all.every(alive), "tree not alive before the kill");
    killTree(root.pid!);
    const until = Date.now() + 10_000;
    while (all.some(alive) && Date.now() < until) await delay(100);
    assert.deepEqual(all.filter(alive), [], "survivors after killTree");
  } finally {
    for (const p of all) if (alive(p)) process.kill(p, "SIGKILL");
  }
});

test("sampler query time widens the silence limit; failed queries are counted, not sampled", () => {
  const guard = new ProcessGuard(permissive, () => {}, 2000, 10_000);
  const ingest = (l: string) => (guard as unknown as { ingest(line: string): boolean }).ingest(l);
  assert.equal(guard.silenceLimitMs, 3 * 2000 + 10_000);
  const sample = (q: number) => JSON.stringify({ t: 1, q, p: [[1, 0, "x.exe", 5]], free: 1, total: 2, commit: 0, limit: 0 });
  assert.equal(ingest(sample(5000)), true);
  assert.equal(guard.silenceLimitMs, 3 * (2000 + 5000) + 10_000);
  assert.equal(guard.maxQueryMs, 5000);
  assert.equal(ingest(JSON.stringify({ t: 2, err: "Invalid class" })), false);
  assert.equal(guard.samplerErrors, 1);
  assert.equal(guard.lastSamplerError, "Invalid class");
  // A slow query ages out after 10 newer samples.
  for (let i = 0; i < 10; i++) ingest(sample(100));
  assert.equal(guard.silenceLimitMs, 3 * (2000 + 100) + 10_000);
  // One pathologically slow query cannot widen the limit past the cap.
  ingest(sample(10 * 60_000));
  assert.equal(guard.silenceLimitMs, MAX_SILENCE_LIMIT_MS);
  assert.equal(MAX_SILENCE_LIMIT_MS, 60_000);
});

test("a reused owner PID (same PID, different start time) ends the sampler", { skip: !win && "sampler is Windows-only" }, async () => {
  const aborts: AbortInfo[] = [];
  const guard = new ProcessGuard(permissive, (a) => aborts.push(a), 500);
  try {
    guard.simulateOwnerPidReuse();
    await guard.start();
    assert.equal(aborts.length, 1);
    assert.match(aborts[0]!.reason, /sampler exited \(0\)/);
  } finally {
    guard.stop();
  }
});

test("a harness event-loop stall longer than the silence limit is not a silent sampler", { skip: !win && "sampler is Windows-only" }, async () => {
  const aborts: AbortInfo[] = [];
  const guard = new ProcessGuard(permissive, (a) => aborts.push(a), 500);
  try {
    await guard.start();
    // Block the event loop like the synchronous sweep() does, past 3 intervals + query allowance (11.5 s).
    const until = Date.now() + 13_000;
    while (Date.now() < until) {
      /* busy */
    }
    await delay(2000);
    assert.deepEqual(aborts, []);
  } finally {
    guard.stop();
  }
});

test("a sampler that really dies still aborts fail-closed", { skip: !win && "sampler is Windows-only" }, async () => {
  const aborts: AbortInfo[] = [];
  const guard = new ProcessGuard(permissive, (a) => aborts.push(a), 500);
  try {
    await guard.start();
    killTree(guard.samplerPid!);
    await delay(2500);
    assert.equal(aborts.length, 1);
    assert.match(aborts[0]!.reason, /sampler (exited|silent)/);
  } finally {
    guard.stop();
  }
});

test("a hung sampler is caught even while the harness event loop keeps stalling", { skip: !win && "sampler is Windows-only" }, async () => {
  const aborts: AbortInfo[] = [];
  // 500 ms interval, 1 s query allowance: silence limit 2.5 s of listening.
  const guard = new ProcessGuard(permissive, (a) => aborts.push(a), 500, 1000);
  try {
    await guard.start();
    guard.simulateHungSampler();
    // Every watchdog tick lands late (stalls of 1.2 s with short gaps). The old
    // watchdog moved its "last sample" mark forward on each late tick and so
    // never saw the hung sampler.
    const deadline = Date.now() + 20_000;
    while (aborts.length === 0 && Date.now() < deadline) {
      const until = Date.now() + 1200;
      while (Date.now() < until) {
        /* busy */
      }
      await delay(50);
    }
    assert.equal(aborts.length >= 1, true, "hung sampler not detected within 20 s of repeated stalls");
    assert.match(aborts[0]!.reason, /sampler silent for \d+ ms of listening/);
    assert.ok(guard.maxLoopLagMs >= 600, `loop lag tracked (${guard.maxLoopLagMs} ms)`);
  } finally {
    guard.stop();
  }
});
