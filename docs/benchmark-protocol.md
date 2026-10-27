# Benchmark protocol

The harness under `benchmarks/` extends upstream `packages/producer/src/benchmark.ts`. It uses the same `createRenderJob` + `executeRenderJob` entry point, the same `perfSummary`, and the same fixture layout (`src/index.html` + `meta.json`). Upstream code is never modified; everything extra is observed from outside the render.

## Reproduce

Requirements: Node 24, Bun, FFmpeg and ffprobe on `PATH`, and optionally `nvidia-smi` for GPU/VRAM sampling.

```bash
git submodule update --init
cd upstream/hyperframes && bun install --frozen-lockfile && bun run build && cd ../..
node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs benchmarks/src/run-benchmark.ts --warm-runs 5
```

Runner options:

| Option | Effect |
|---|---|
| `--fixtures a,b` | Run only these fixtures |
| `--profiles producer-default,cli-local-default` | Profiles to run, from `benchmarks/src/profiles.ts` |
| `--control <profile>` / `--no-control` | Add or skip the uninstrumented control cell. Default: control for `producer-default` |
| `--out dir` | Write results to `dir` |
| `--strict-idle` | Refuse to run on a busy host instead of only flagging it |
| `--settle-ms n` | Settle cooldown before every run (default 5000; 0 = back to back) |
| `--max-chrome`, `--min-free-ram-pct`, `--min-free-ram-gib`, `--max-commit-pct`, `--max-consecutive-failures` | Fail-closed host limits; see *Host safety* |

Other commands, run from `benchmarks/` (`benchmarks/package.json` has the same commands as scripts):

- Regenerate the report from raw data: `node --import … src/report.ts results/<dir>`
- Calibration diagnostic: `node --import … src/diag-calibration.ts --out results/<dir>/diagnostics/<name>`. It renders one fixture in four modes (a fresh process per run or the same process, each with or without the settle wait) and records the calibration outcome per run, with upstream's full warning metadata.
- Recompute every number the ADR quotes: `node --import … src/adr-facts.ts results/<dir>`
- Typecheck: `../upstream/hyperframes/node_modules/.bin/tsc -p tsconfig.json`

## Method

- **Cells.** A cell is one fixture with one variant. Each cell runs in a fresh Node child process with a fresh, empty extraction-cache dir (`HYPERFRAMES_EXTRACT_CACHE_DIR`).
- **Cold vs warm.** Run 0 is **cold**: new process, new Chrome, empty cache. Runs 1..N are **warm**: same process and same project dir, so upstream can reuse its browser pool and extraction cache exactly as it would for a user re-export. Cold results are never mixed into warm statistics.
- **Variants and interleaving.** There are three variants: `producer-default`, `cli-local-default` and `producer-default.control`.
  - Each variant of a fixture has its own warm worker process (`render-worker.ts --serve`). The runner sends these processes one run at a time.
  - Order: every variant's cold run first, then warm rounds A,B,C,A,B,C,…
  - The variant order rotates by (fixture index + run), so slow host drift hits every variant alike.
  - Only one render runs at a time. Idle workers stay alive between their runs.
- **Control.** A control cell runs with no CDP tap, no GPU or process-tree samplers, and `HF_PROFILE_FALLBACK_CAPTURE` unset. It records wall time and ffprobe output only. `overhead.csv` and the report's *Harness overhead* table compare it with the instrumented cell of the same profile.
- **Settle wait.** Before every run (`--settle-ms`, default 5000), the worker waits up to 60 s for every `chrome-headless-shell.exe`, `ffmpeg.exe` and `ffprobe.exe` on the host to exit, then sleeps the fixed cooldown.
  - The result is recorded per run under `settle` (alive at start and at end, waited ms).
  - Desktop `chrome.exe` is not watched. The benchmark host must not run other headless-shell or FFmpeg work.
  - `--settle-ms 0` runs back to back.
- **Idle gate.** Before the benchmark starts, a 10 s check runs; before every run, a 3 s check. Thresholds: CPU < 20 % (above this desktop's measured noise floor of ~10-14 %) and GPU util < 15 %. The gate retries for up to 60 s.
  - Each run records `idle.attempts` and `idle.ok`.
  - `ok=false` is counted as an *idle flag*.
  - With `--strict-idle`, a busy host makes the run refused and written as `{refused:true}`.
  - Cells with warm cv > 10 % are listed in the report together with per-run setup time and idle attempts.
- **Samplers.**
  - `nvidia-smi` every 200 ms: utilisation of gpu/enc/dec and `memory.used`. ΔVRAM is measured against a sample taken right before the run.
  - Process tree (PowerShell CIM) every 1 s: summed working set, CPU seconds and I/O transfer bytes of Node and every descendant.
  - CDP tap: in-memory patching of puppeteer `Connection._rawSend`/`onMessage`, which counts request bytes (`sentBytes`) and response bytes (`bytes`) per method, plus per-call latency.
- **Capture path per run.** Upstream auto-calibration can choose a different capture path or worker count between runs of one cell (`perfSummary.observability.capture.capturePath`, `perfSummary.workers`).
  - Both values are recorded per run in `runs.csv`.
  - A cell whose warm runs used more than one (path, workers) pair is marked `mixedPath`, and its `capturePath` fact is `mixed`.
  - The report's *Mixed capture path* table gives a separate distribution per path. Its pooled medians must not be read as one pipeline.
- **Stage overlap.** Upstream `[Render:trace]` end events give `[elapsed − duration, elapsed]` intervals, and `trace-analysis.ts` sweeps them.
  - The self-encoding capture stages (`capture_streaming`, `capture_hdr_layered`) emit no `encode` event. For those, an `encode` interval is **inferred** from `perfSummary.stages.encodeMs`, aligned to the end of the capture stage, and listed under `inferredPhases`. If a run has more than one self-encoding segment, nothing is inferred and the run carries a `traceWarnings` entry instead.
  - The critical path is a heuristic, not a dependency graph: at each instant it takes the stage that ends last.
- **Statistics.** With n = 5 warm runs, a nearest-rank p95 equals the max, so the report shows median, **max** and cv. Raw `Distribution` objects keep `p95` for larger n.
- **Cost.** The measured cost figures are CPU-seconds and wall-seconds per output minute. `est. $/output-min` is an **estimate**: CPU-seconds × a reference vCPU-hour price. The price defaults to AWS c7i.xlarge on-demand in us-east-1 ($0.0446/vCPU-h, a public list price as known in 2025) and can be overridden with `BENCH_USD_PER_VCPU_HOUR`. The source string is written into `summary.json → referenceRate`.

## Host safety

An earlier full baseline froze the benchmark desktop and needed a hard reset. Dozens of visible console windows appeared, each from a `chrome-headless-shell` NetworkService utility process failing with `0x800700e8` (`ERROR_NO_DATA`: the pipe to its parent had already closed). The harness now has these guards (`benchmarks/src/process-guard.ts`):

- **Hidden consoles.** Every `spawn`/`spawnSync` in `benchmarks/src` passes `windowsHide: true`. Chrome is launched by upstream through puppeteer, so the harness cannot set this flag on it. Chrome and FFmpeg are console programs: they inherit the worker's hidden console instead of each opening a visible window. A worker without `windowsHide`, started from a parent that has no console, gets a new visible console, and so does every descendant that does not inherit one.
- **Process ownership.** A hidden PowerShell loop samples the process table every 2 s.
  - Every process descended from a worker the runner started is tracked by (PID, creation time). PID reuse can therefore never make the harness kill an unrelated process.
  - A tracked process stays tracked after its parent dies. This covers the orphan case that `taskkill /T` cannot reach.
  - Processes are never killed by image name alone.
- **Tree kill.** The runner kills a worker's whole tree with `taskkill /T /F /PID` in each of these cases:
  - a run takes longer than 20 min;
  - `close` takes longer than 60 s;
  - the guard aborts;
  - the harness gets SIGINT, SIGTERM or SIGHUP, or exits.

  After every fixture, and at teardown, it sweeps any tracked survivor. Swept processes are listed in `run-manifest.json → guard.leftovers`.
- **Fail-closed resource limits.** The run aborts when any limit is crossed: all workers are killed, the sweep runs, `run-manifest.json → abort` records the reason and the sample that triggered it, no report is written, and the exit code is 3.

  | Limit | Default | Option |
  |---|---|---|
  | Live `chrome-headless-shell.exe` processes, host-wide | 80 (a 5-worker render peaked at 25 in the smoke test) | `--max-chrome` |
  | Free physical RAM | ≥ max(15 %, 4 GiB) | `--min-free-ram-pct`, `--min-free-ram-gib` |
  | Commit charge | ≤ 90 % of the commit limit | `--max-commit-pct` |
  | Consecutive failed runs (run error, worker death, or upstream calibration failure) | 3 | `--max-consecutive-failures` |

  The limits are checked once before any render starts. The run refuses to start on a host that is already over a limit.
- **The guard fails closed.** The run aborts the same way if the sampler errors or exits, sends no first sample within 30 s, or goes silent for more than 3 intervals plus a 10 s query allowance (16 s of listening time). It also aborts if its own event loop is blocked for more than 60 s, because nothing enforces the limits meanwhile. A blind guard does not let the run continue.
  - Why the allowance: one sample cycle is the 2 s sleep plus the CIM queries. Those queries took about 0.8 s on an idle host with about 500 processes, and longer while renders saturated the CPU. The earlier 6 s limit aborted a fidelity calibration run mid-render on this shared host.
  - Silence is counted in listening time, and only a real sample resets it. A watchdog tick that is itself late, because for example the synchronous end-of-fixture sweep blocked the event loop, credits one interval rather than the blocked time. Samples sent meanwhile may still be unread. Repeated stalls still accumulate silence, so a hung sampler is always caught; a test covers a hung sampler during repeated stalls. Event-loop lag is tracked separately (`maxLoopLagMs`). Before the stall handling, two PR01 calibration attempts aborted right after the first fixture's sweep.
- **No sampler outlives the harness.** The guard sampler and the per-run process-tree sampler both take the PID of their owning Node process.
  - Each loop exits as soon as that PID is gone. Node does not kill its children when it exits.
  - The guard loop runs with `$ErrorActionPreference = 'Stop'`.
  - Closing only the pipe does not end either loop: in `sampler-owner-exit.log` both samplers were still alive 32 s after the pipe closed, and exited once the owner died. The guard catches the silence and aborts.
  - Every harness exit path runs one teardown: normal end, abort, `--strict-idle` refusal, a rejected `main()`, an uncaught exception or rejection, and SIGINT/SIGTERM/SIGHUP. The teardown kills live worker trees, sweeps tracked survivors, and stops the sampler.
- **Worker stderr.** The full stderr of each worker is kept in `raw/<fixture>/<variant>/worker-stderr.log`. Upstream prints its GPU-mode probe result (`browserGpuMode probe → …`) and Chrome launch errors there, not through the job logger.

`diag-calibration.ts` uses the same guard and kill paths.

Fault-injection checks (test only):

- `--inject-worker-kill-ms <ms>` kills one worker process in the middle of a run in the last round. It kills the process only, not its tree. Expected: the killed cell is recorded with `exitCode: 1`, the other cells finish, and no `chrome-headless-shell` or `ffmpeg` process is left on the host.
- `--inject-sampler-kill-ms <ms>` kills the guard sampler that many ms after the first render starts. Expected: the run aborts with `host-safety sampler exited`, exits with code 3, writes no report, and leaves no process behind.

The recorded evidence is in `results/2026-10-27-1c4a1c1/diagnostics/fault-injection/`. Run this check with one fixture and `--warm-runs 1` before every full baseline on a new host.

## Fixtures

Fixtures are listed in `benchmarks/fixtures/manifest.json`. Local golden fixtures are tagged `turbo-golden` and render at 1920×1080, 30 fps. Media comes from FFmpeg `lavfi` recipes in `media-recipes.json`; it is generated on first use, cached in `benchmarks/.cache/` (gitignored), and its hashes are recorded in every run.

| Category | Fixture |
|---|---|
| Typography + SVG | `typography-svg` |
| GSAP static holds | `gsap-static-holds` |
| CSS filters / blend | `css-filters-blend` |
| Canvas / WebGL | `canvas-webgl` |
| Video-heavy (H.264, HEVC 60 fps, VFR) | `video-heavy` |
| Audio | `audio-mix` |
| Mixed | `mixed-complex` |
| Alpha (upstream) | `webm-transparency` |
| HDR (upstream) | `hdr-hlg-regression`, `hdr-regression` |

## Output layout and schemas

```text
benchmarks/results/<YYYY-MM-DD>-<upstreamSha7>/
  environment.json        turbo-bench-environment/1 (home dir replaced by ~)
  run-manifest.json       turbo-bench-manifest/1   (command, window, profiles, control, order rule, preflight, cell exit codes)
  raw/<fixture>/<variant>/run-<n>.json   turbo-bench-run/1, or /2 once a fidelity record is attached
  outputs/<fixture>/<variant>/run-<n>.*  only with --keep-output (gitignored)
  fidelity-report.{json,md}              only after run-fidelity.ts --results
  runs.csv                one row per run (RunMetrics in benchmarks/src/report.ts)
  summary.csv / summary.json   turbo-bench-summary/2 (per cell: cold, warm Distribution per metric; referenceRate; harnessOverhead; pathGroups + mixedPath per cell)
  overhead.csv            instrumented vs control wall time per fixture
  adr-facts.json          every range quoted by the ADR, recomputed from summary.json
  report.md
```

`benchmarks/environment.json` is a copy of the environment manifest of the latest default-location run. It is never written by hand, and ad-hoc `--out` runs do not touch it.

### `turbo-bench-run/1` (raw data, the source of truth)

| Field | Meaning |
|---|---|
| `fixture`, `category`, `source`, `fixtureSourceSha256`, `inputs.media/vendor` | Provenance; every input is identified by hash |
| `profile`, `instrumented`, `profileEnv` | Variant name; `false` for control cells; every `PRODUCER_*`/`HF_*`/`HYPERFRAMES_*` env var in effect |
| `resolvedEngineConfig` | Run 0 only. Upstream `resolveConfig()` output, i.e. which fast paths were eligible |
| `run`, `kind` (`cold`/`warm`), `startedAt`, `wallMs`, `error`, `jobStatus` | Identity and outcome. The host temp dir is written as `$TMP`. `wallMs` measures `executeRenderJob` from start to end |
| `idle` | Gate result before this run: `{ok, cpuBusyPct, gpuUtilPct, gpuEncPct, attempts, thresholds}` |
| `cdpTap` | `inboundBytes`, `outboundBytes`, `eventBytes`, and `byMethod[m] = {calls, bytes, sentBytes, latenciesMs[]}`. `null` in control cells |
| `gpu`, `gpuTimeline` | GPU summary (avg/peak util, peak VRAM, ΔVRAM) and samples `[t, gpu%, enc%, dec%, MiB]` |
| `processTree`, `processTreeTimeline` | Peak working set (total and by process name), CPU s, read/write transfer bytes; samples `[t, bytes, count]`. `null` in control cells |
| `extractCacheBytesAfter` | Size of the extraction cache dir after the run |
| `output` | ffprobe result: size, duration, bitrate, and per stream codec/pix_fmt/frame rate/packets/colour/alpha_mode/audio |
| `traceEvents` | Every upstream `[Render:trace]` event from the full logger stream, not the copy capped at 160 events |
| `perfSummary` | Upstream `RenderPerfSummary`, unmodified |

Every derived metric in `RunMetrics` (`report.ts`) is a pure function of one raw run.

### `turbo-bench-run/2`

`/2` is `/1` plus one optional `fidelity` key holding a `turbo-fidelity/1` record. Existing fields are unchanged. `run-fidelity.ts --results` attaches the record to each candidate run it gates, and `report.ts` reads both `/1` and `/2`. The record holds:

- the verdict and reasons;
- the reference and candidate files with their sha256;
- the threshold path and file hash;
- every check's details;
- the gate's wall time and peak RSS.

## Fidelity

Speed numbers count only for output that passes the fidelity gate against the Chromium reference. The method, thresholds and commands are in [fidelity-protocol.md](fidelity-protocol.md).

- `--fixture-set baseline|fidelity|all` (default `baseline`) adds the fidelity-only fixtures from `fixtures/fidelity-manifest.json`:
  - `fps-ntsc-30000-1001`;
  - `motion-blur`;
  - `transition-crossfade`.

  The baseline set and its results are unchanged.
- `--keep-output` (opt-in) copies each output to `outputs/<fixture>/<cell>/run-<n>.<ext>` (gitignored), after wall time and probe are recorded. The raw run records the copy's path and sha256. The copy happens outside the timed region; see the PR01 evidence for its effect on wall time.

## Known measurement limits

- The CDP tap counts bytes as puppeteer sees them. Readback inside Chrome (GPU → CPU) is not visible.
- Pixels that never cross CDP are visible only as process-tree disk I/O and `tmpPeakBytes`. The main example is the HDR layered path, where FFmpeg pre-extracts native HDR frames and Node composites them (`producer/src/services/renderOrchestrator.ts:4551-4555`).
- Working set is sampled every 1 s, so short peaks can be missed. Upstream `peakRssMb` covers the Node process only.
- `frameRpcResponseBytes` counts responses of `Page.captureScreenshot`, `HeadlessExperimental.beginFrame` and `Runtime.callFunctionOn`. The last of these also carries small non-frame replies; the per-method split is in `cdpTap.byMethod`.
- The guard samples the process table every 2 s. A grandchild whose intermediate parent starts and dies between two samples is never linked to a worker, so the sweep cannot reach it. In this pipeline Chrome and FFmpeg are direct children of the worker or of the Chrome browser process, both of which live longer than one sample. The host-wide Chrome cap still counts such a process.
- The inferred `encode` interval assumes upstream finalises encoding when the capture stage ends. Its start is derived from the reported duration, not observed.
