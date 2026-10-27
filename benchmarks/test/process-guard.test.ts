/** Host-safety guard: the sampler watchdog must tell a blocked harness from a dead sampler (Windows only). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_LIMITS, killTree, ProcessGuard, type AbortInfo } from "../src/process-guard.js";

const permissive = { ...DEFAULT_LIMITS, minFreeRamBytes: 0, minFreeRamFraction: 0, maxCommitFraction: 1, maxChrome: 10_000 };
const win = process.platform === "win32";

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
