/**
 * Guarded FFmpeg/ffprobe launcher for the fidelity gate.
 *
 * The gate never starts Chrome (renders go through run-benchmark.ts and its
 * ProcessGuard). It does start many short FFmpeg processes, so every launch
 * goes through here:
 * - `windowsHide` so no console window can appear;
 * - at most MAX_CONCURRENT live processes;
 * - a per-process timeout that kills the whole tree (`killTree`);
 * - a registry of live PIDs killed on exit / SIGINT / SIGTERM, so an aborted
 *   gate leaves nothing behind.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killTree } from "../process-guard.js";

export const FFMPEG = process.env.FIDELITY_FFMPEG ?? "ffmpeg";
export const FFPROBE = process.env.FIDELITY_FFPROBE ?? "ffprobe";

const MAX_CONCURRENT = 3;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

const live = new Set<number>();
let active = 0;
const waiters: Array<() => void> = [];
let hooked = false;

function killAll(): void {
  for (const pid of live) killTree(pid);
  live.clear();
}

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      killAll();
      process.exit(130);
    });
  }
}

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
  active++;
}

function release(): void {
  active--;
  waiters.shift()?.();
}

/** Number of tool processes currently alive (tests assert this returns to 0). */
export function liveProcessCount(): number {
  return live.size;
}

export interface SpawnedTool {
  child: ChildProcess;
  /** Resolves with the exit code once the process is gone; stderr tail on failure. */
  done: Promise<{ code: number; stderr: string }>;
}

/**
 * Start a tool with stdout piped (for streaming readers). The caller must
 * consume stdout. Concurrency slot and registry entry are released on exit.
 */
export async function spawnTool(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; stdin?: boolean } = {},
): Promise<SpawnedTool> {
  hookExit();
  await acquire();
  let child: ChildProcess;
  try {
    child = spawn(cmd, args, { stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true, cwd: opts.cwd });
  } catch (err) {
    release();
    throw err;
  }
  const pid = child.pid;
  if (pid !== undefined) live.add(pid);
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => {
    stderr = (stderr + d).slice(-64 * 1024);
  });
  const timer = setTimeout(() => {
    stderr += `\n[fidelity] ${cmd} exceeded ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms; killed`;
    if (pid !== undefined) killTree(pid);
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const done = new Promise<{ code: number; stderr: string }>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid !== undefined) live.delete(pid);
      release();
      resolve({ code, stderr });
    };
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(127);
    });
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
  return { child, done };
}

/** Run a tool to completion and collect stdout (bounded). Throws on non-zero exit. */
export async function runTool(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; maxStdoutBytes?: number; allowFailure?: boolean } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const { child, done } = await spawnTool(cmd, args, opts);
  const max = opts.maxStdoutBytes ?? 512 * 2 ** 20;
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  child.stdout!.on("data", (d: Buffer) => {
    size += d.length;
    if (size > max) {
      if (!overflow && child.pid !== undefined) killTree(child.pid);
      overflow = true;
      return;
    }
    chunks.push(d);
  });
  const { code, stderr } = await done;
  if (overflow) throw new Error(`${cmd} stdout exceeded ${max} bytes`);
  if (code !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.slice(0, 12).join(" ")} … exited ${code}: ${stderr.trim().split("\n").slice(-4).join(" | ")}`);
  }
  return { code, stdout: Buffer.concat(chunks), stderr };
}
