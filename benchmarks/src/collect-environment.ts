/**
 * Generates the machine/toolchain manifest for a benchmark run. Every value is
 * probed from the live host or the pinned checkout; nothing is hand-written.
 *
 *   node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs \
 *     benchmarks/src/collect-environment.ts [--out benchmarks/environment.json]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem, release, platform, arch, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BENCH_ROOT, REPO_ROOT, UPSTREAM_ROOT } from "./fixtures.js";

function run(cmd: string, args: string[], cwd?: string): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd, windowsHide: true });
  return r.status === 0 ? r.stdout.split(String.fromCharCode(13)).join("").trim() : null;
}

function powershellJson(script: string): any {
  const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${script} | ConvertTo-Json -Compress -Depth 4`]);
  try {
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function chromeInfo(): Promise<Record<string, unknown>> {
  const { resolveHeadlessShellPath } = await import(
    pathToFileURL(join(UPSTREAM_ROOT, "packages", "engine", "src", "services", "browserManager.ts")).href
  );
  const path: string | undefined = resolveHeadlessShellPath();
  if (!path) return { headlessShellPath: null, version: null };
  const puppeteer = await import(
    pathToFileURL(
      join(UPSTREAM_ROOT, "packages", "engine", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js"),
    ).href
  );
  let version: string | null = null;
  try {
    const browser = await puppeteer.default.launch({ executablePath: path, headless: true, args: ["--no-sandbox"] });
    version = await browser.version();
    await browser.close();
  } catch (err) {
    version = `unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { headlessShellPath: path, version };
}

/** Replace the user's home directory with `~` in every string value. */
function redactHome<T>(value: T): T {
  const home = homedir();
  if (!home) return value;
  return JSON.parse(JSON.stringify(value), (_k, v) =>
    typeof v === "string" ? v.split(home).join("~").split(home.replace(/\\/g, "/")).join("~") : v,
  );
}

export async function collectEnvironment(): Promise<Record<string, unknown>> {
  return redactHome(await probeEnvironment());
}

async function probeEnvironment(): Promise<Record<string, unknown>> {
  const gitUp = (args: string[]) => run("git", args, UPSTREAM_ROOT);
  const nvidia = run("nvidia-smi", [
    "--query-gpu=name,driver_version,memory.total,pcie.link.gen.max,pcie.link.width.max,power.limit,clocks.max.graphics,vbios_version",
    "--format=csv,noheader",
  ]);
  const ffmpegVersion = run("ffmpeg", ["-hide_banner", "-version"]);
  const ffmpegEncoders = run("ffmpeg", ["-hide_banner", "-encoders"]) ?? "";
  const os = powershellJson(
    "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture",
  );
  const cpu = powershellJson(
    "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed",
  );
  const mem = powershellJson("Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,Speed,ConfiguredClockSpeed");
  const disk = powershellJson("Get-PhysicalDisk | Select-Object FriendlyName,MediaType,BusType,Size");
  const power = run("powercfg", ["/getactivescheme"]);

  return {
    schema: "turbo-bench-environment/1",
    generatedAt: new Date().toISOString(),
    generator: "benchmarks/src/collect-environment.ts",
    repo: {
      turboSha: run("git", ["rev-parse", "HEAD"], REPO_ROOT),
      turboDirty: (run("git", ["status", "--porcelain", "--", "benchmarks/src", "benchmarks/fixtures"], REPO_ROOT) ?? "") !== "",
    },
    upstream: {
      repository: "https://github.com/heygen-com/hyperframes",
      submodulePath: "upstream/hyperframes",
      sha: gitUp(["rev-parse", "HEAD"]),
      describe: gitUp(["log", "-1", "--format=%H %cI %s"]),
      dirty: (gitUp(["status", "--porcelain"]) ?? "") !== "",
      lockfile: "bun.lock",
      lockfileSha256: sha256(join(UPSTREAM_ROOT, "bun.lock")),
      producerVersion: JSON.parse(readFileSync(join(UPSTREAM_ROOT, "packages", "producer", "package.json"), "utf8")).version,
    },
    toolchain: {
      node: process.version,
      bun: run("bun", ["--version"]),
      tsx: JSON.parse(readFileSync(join(UPSTREAM_ROOT, "node_modules", "tsx", "package.json"), "utf8")).version,
      ffmpeg: ffmpegVersion?.split("\n")[0] ?? null,
      ffmpegConfiguration: ffmpegVersion?.split("\n").find((l) => l.startsWith("configuration:")) ?? null,
      ffprobe: run("ffprobe", ["-hide_banner", "-version"])?.split("\n")[0] ?? null,
      ffmpegHardwareEncodersCompiledIn: ["h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_qsv", "h264_amf"].filter((e) =>
        new RegExp(`\\s${e}\\s`).test(ffmpegEncoders),
      ),
      chrome: await chromeInfo(),
    },
    host: {
      platform: platform(),
      arch: arch(),
      kernelRelease: release(),
      os,
      cpu,
      cpuModelNode: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      ramBytes: totalmem(),
      memoryModules: mem,
      disks: disk,
      powerScheme: power,
      gpu: nvidia
        ? nvidia.split("\n").map((l) => {
            const [name, driver, vram, pcieGen, pcieWidth, powerLimit, maxClock, vbios] = l.split(",").map((s) => s.trim());
            return { name, driver, vram, pcieGen, pcieWidth, powerLimit, maxClock, vbios };
          })
        : [],
    },
    testedPlatforms: ["windows-x64-d3d11-nvidia"],
    notTested: [
      "macOS (Metal, Apple Silicon)",
      "Linux with hardware GPU (NVENC/VAAPI)",
      "Linux SwiftShader (headless/Docker)",
      "Windows AMD or Intel GPU",
    ],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  const i = process.argv.indexOf("--out");
  const out = i >= 0 ? process.argv[i + 1]! : join(BENCH_ROOT, "environment.json");
  collectEnvironment()
    .then((env) => {
      writeFileSync(out, JSON.stringify(env, null, 2) + "\n");
      console.log(`environment written to ${out}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
