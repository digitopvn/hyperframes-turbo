/**
 * Fault injection: kill only the owner of the PowerShell samplers (host-safety
 * guard and per-run process tree) and measure when each sampler exits.
 *
 *   diag-sampler-owner.ts [--trials 3] [--out <dir>]
 *
 * The owner is always killed with `taskkill /F /PID <owner>` WITHOUT `/T`, so
 * the kill itself never targets a sampler. Two topologies:
 *
 * - `parent-owner` (what the harness does): the owner Node process spawns the
 *   samplers. On Windows a non-detached child does not outlive its Node parent
 *   (Node docs, `child_process.spawn` `options.detached`), so this shows the
 *   samplers end with the owner, whatever ends them.
 * - `external-owner` (isolates the owner check): this process spawns the
 *   samplers but names an unrelated idle process as their owner. Killing that
 *   process leaves the samplers' parent alive, so only the samplers' own owner
 *   check (PID + start time) can end them. It must do so within one sleep
 *   interval plus the slowest CIM query the guard reported, plus the polling
 *   step.
 *
 * Writes <out>/sampler-owner-kill.json and .md. Exit 0 when every trial
 * passed, 1 otherwise, 2 on bad usage. Windows only.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_LIMITS, killTree, ProcessGuard, type AbortInfo } from "./process-guard.js";
import { ProcessTreeSampler } from "./system-probes.js";

const GUARD_INTERVAL_MS = 2000;
const TREE_INTERVAL_MS = 1000;
const POLL_MS = 100;
const GIVE_UP_MS = 30_000;
const permissive = { ...DEFAULT_LIMITS, minFreeRamBytes: 0, minFreeRamFraction: 0, maxCommitFraction: 1, maxChrome: 100_000 };

type Topology = "parent-owner" | "external-owner";

interface Samplers {
  owner: number;
  guardSampler: number;
  treeSampler: number;
  guardMaxQueryMs: number;
}

/** `--owner` mode: start both samplers owned by this process, report, then idle until killed. */
async function ownerMode(): Promise<void> {
  const guard = new ProcessGuard(permissive, (a) => process.stdout.write(`${JSON.stringify({ abort: a.reason })}\n`), GUARD_INTERVAL_MS);
  await guard.start();
  const tree = new ProcessTreeSampler(process.pid, TREE_INTERVAL_MS);
  tree.start();
  // Let both loops complete a few cycles so the measured query time is real.
  await delay(3 * GUARD_INTERVAL_MS);
  process.stdout.write(`${JSON.stringify({ owner: process.pid, guardSampler: guard.samplerPid, treeSampler: tree.pid, guardMaxQueryMs: guard.maxQueryMs })}\n`);
  setInterval(() => {}, 60_000);
}

function readJsonLine<T>(child: ChildProcess, accept: (m: Record<string, unknown>) => T | null, what: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new Error(`${what}: no report within 60 s`)), 60_000);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (c: string) => {
      buf += c;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof m.abort === "string") {
          clearTimeout(t);
          rej(new Error(`${what}: guard aborted before the fault: ${m.abort}`));
          return;
        }
        const v = accept(m);
        if (v !== null) {
          clearTimeout(t);
          res(v);
          return;
        }
      }
    });
    child.on("exit", (c) => rej(new Error(`${what}: exited early (${c})`)));
  });
}

/** PID -> parent PID for the given PIDs that are alive right now. */
function parentsOf(pids: number[]): Map<number, number> {
  const filter = pids.map((p) => `ProcessId=${p}`).join(" or ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`], { encoding: "utf8", windowsHide: true });
  const out = new Map<number, number>();
  for (const l of (r.stdout ?? "").split("\n")) {
    const [pid, ppid] = l.trim().split(" ").map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) out.set(pid!, ppid!);
  }
  return out;
}

/** Cheap liveness probe for the polling loop (no PowerShell start-up per poll). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Trial extends Samplers {
  topology: Topology;
  trial: number;
  /** Parent PID of each sampler just before the kill. */
  guardParent: number | null;
  treeParent: number | null;
  killCommand: string;
  killExit: number | null;
  /** ms from the kill returning to each sampler being gone; null = still alive after GIVE_UP_MS. */
  guardExitMs: number | null;
  treeExitMs: number | null;
  allowedGuardMs: number;
  allowedTreeMs: number;
  /** external-owner only: the guard must report its sampler's exit (fail-closed abort). */
  guardAbort: string | null;
  ok: boolean;
}

async function killOwnerAndWatch(s: Samplers): Promise<Pick<Trial, "killCommand" | "killExit" | "guardExitMs" | "treeExitMs">> {
  const killArgs = ["/F", "/PID", String(s.owner)];
  const k = spawnSync("taskkill", killArgs, { stdio: "ignore", windowsHide: true });
  const t0 = Date.now();
  let guardExitMs: number | null = null;
  let treeExitMs: number | null = null;
  while (Date.now() - t0 < GIVE_UP_MS && (guardExitMs === null || treeExitMs === null)) {
    if (guardExitMs === null && !alive(s.guardSampler)) guardExitMs = Date.now() - t0;
    if (treeExitMs === null && !alive(s.treeSampler)) treeExitMs = Date.now() - t0;
    await delay(POLL_MS);
  }
  // Never leave a sampler behind, whatever the outcome.
  for (const pid of [s.guardSampler, s.treeSampler]) if (alive(pid)) killTree(pid);
  return { killCommand: `taskkill ${killArgs.join(" ")}`, killExit: k.status, guardExitMs, treeExitMs };
}

async function parentOwnerTrial(n: number): Promise<Trial> {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--owner"], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  const s = await readJsonLine(child, (m) => (typeof m.owner === "number" ? (m as unknown as Samplers) : null), "owner");
  const parents = parentsOf([s.guardSampler, s.treeSampler]);
  const guardParent = parents.get(s.guardSampler) ?? null;
  const treeParent = parents.get(s.treeSampler) ?? null;
  if (guardParent !== s.owner || treeParent !== s.owner) {
    killTree(s.owner);
    throw new Error(`samplers are not live children of the owner before the fault (parents ${guardParent}, ${treeParent})`);
  }
  const k = await killOwnerAndWatch(s);
  const allowedGuardMs = GUARD_INTERVAL_MS + s.guardMaxQueryMs + POLL_MS;
  const allowedTreeMs = TREE_INTERVAL_MS + s.guardMaxQueryMs + POLL_MS;
  const ok = k.killExit === 0 && k.guardExitMs !== null && k.treeExitMs !== null && k.guardExitMs <= allowedGuardMs && k.treeExitMs <= allowedTreeMs;
  return { topology: "parent-owner", trial: n, ...s, guardParent, treeParent, ...k, allowedGuardMs, allowedTreeMs, guardAbort: null, ok };
}

async function externalOwnerTrial(n: number): Promise<Trial> {
  const idle = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore", windowsHide: true });
  const owner = idle.pid!;
  const aborts: AbortInfo[] = [];
  const guard = new ProcessGuard(permissive, (a) => aborts.push(a), GUARD_INTERVAL_MS, undefined, owner);
  const tree = new ProcessTreeSampler(owner, TREE_INTERVAL_MS, owner);
  try {
    await guard.start();
    tree.start();
    await delay(3 * GUARD_INTERVAL_MS);
    if (aborts.length) throw new Error(`guard aborted before the fault: ${aborts[0]!.reason}`);
    const s: Samplers = { owner, guardSampler: guard.samplerPid!, treeSampler: tree.pid!, guardMaxQueryMs: guard.maxQueryMs };
    const parents = parentsOf([s.guardSampler, s.treeSampler]);
    const guardParent = parents.get(s.guardSampler) ?? null;
    const treeParent = parents.get(s.treeSampler) ?? null;
    if (guardParent !== process.pid || treeParent !== process.pid) throw new Error(`samplers are not live children of this process before the fault (parents ${guardParent}, ${treeParent})`);
    const k = await killOwnerAndWatch(s);
    await delay(POLL_MS); // let the exit event reach the guard
    const allowedGuardMs = GUARD_INTERVAL_MS + s.guardMaxQueryMs + POLL_MS;
    const allowedTreeMs = TREE_INTERVAL_MS + s.guardMaxQueryMs + POLL_MS;
    const guardAbort = aborts[0]?.reason ?? null;
    const ok =
      k.killExit === 0 && k.guardExitMs !== null && k.treeExitMs !== null && k.guardExitMs <= allowedGuardMs && k.treeExitMs <= allowedTreeMs && /sampler exited \(0\)/.test(guardAbort ?? "");
    return { topology: "external-owner", trial: n, ...s, guardParent, treeParent, ...k, allowedGuardMs, allowedTreeMs, guardAbort, ok };
  } finally {
    guard.stop();
    tree.stop();
    if (alive(owner)) killTree(owner);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--owner")) {
    await ownerMode();
    return -1;
  }
  if (process.platform !== "win32") {
    console.error("[diag-sampler-owner] the samplers are Windows-only");
    return 2;
  }
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const trialsArg = get("trials") ?? "3";
  if (!/^[1-9]\d*$/.test(trialsArg)) {
    console.error("usage: diag-sampler-owner.ts [--trials <positive integer>] [--out <dir>]");
    return 2;
  }
  const out = resolve(get("out") ?? "diag-sampler-owner");
  const trials: Trial[] = [];
  for (const topology of ["parent-owner", "external-owner"] as const) {
    for (let i = 1; i <= Number(trialsArg); i++) {
      const t = topology === "parent-owner" ? await parentOwnerTrial(i) : await externalOwnerTrial(i);
      trials.push(t);
      console.error(
        `[diag-sampler-owner] ${topology} trial ${i}: ${t.killCommand} -> ${t.killExit}; guard sampler gone after ${t.guardExitMs ?? "never"} ms (allowed ${t.allowedGuardMs}), tree sampler after ${t.treeExitMs ?? "never"} ms (allowed ${t.allowedTreeMs})${t.guardAbort ? `; guard: ${t.guardAbort}` : ""} -> ${t.ok ? "ok" : "FAIL"}`,
      );
    }
  }
  const ok = trials.every((t) => t.ok);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "sampler-owner-kill.json"), `${JSON.stringify({ schema: "turbo-diag-sampler-owner/1", generatedAt: new Date().toISOString(), command: `diag-sampler-owner.ts ${argv.join(" ")}`, guardIntervalMs: GUARD_INTERVAL_MS, treeIntervalMs: TREE_INTERVAL_MS, pollMs: POLL_MS, ok, trials }, null, 2)}\n`);
  const L = [
    "# Sampler owner-kill fault injection",
    "",
    "Generated by `benchmarks/src/diag-sampler-owner.ts`. The owner is killed with `taskkill /F /PID <owner>` **without `/T`**; the samplers themselves are never targeted.",
    "",
    "- `parent-owner`: the owner Node process spawned the samplers (the harness topology).",
    "- `external-owner`: this process spawned the samplers and named an unrelated idle process as their owner, so the samplers' parent survives the kill and only their owner check (PID + start time) can end them. The guard must also abort with `sampler exited (0)`.",
    "",
    "Allowed latency: one sleep interval + the slowest CIM query the guard reported before the kill + the 100 ms polling step.",
    "",
    "| topology | trial | owner | guard sampler (parent) | tree sampler (parent) | kill | guard gone after | tree gone after | guard abort | ok |",
    "|---|---:|---:|---|---|---|---:|---:|---|---|",
    ...trials.map(
      (t) =>
        `| ${t.topology} | ${t.trial} | ${t.owner} | ${t.guardSampler} (${t.guardParent}) | ${t.treeSampler} (${t.treeParent}) | \`${t.killCommand}\` → ${t.killExit} | ${t.guardExitMs ?? "never"} ms (≤ ${t.allowedGuardMs}) | ${t.treeExitMs ?? "never"} ms (≤ ${t.allowedTreeMs}) | ${t.guardAbort ?? "—"} | ${t.ok ? "yes" : "**NO**"} |`,
    ),
    "",
  ];
  writeFileSync(join(out, "sampler-owner-kill.md"), L.join("\n"));
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (c) => {
      if (c >= 0) process.exit(c);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
