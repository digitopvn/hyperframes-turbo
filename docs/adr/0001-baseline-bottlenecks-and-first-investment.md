# ADR 0001: Measured baseline bottlenecks and where to invest first

- Status: Proposed (PR00)
- Date: 2026-10-27
- Evidence: [`benchmarks/results/2026-10-27-1c4a1c1/`](../../benchmarks/results/2026-10-27-1c4a1c1/report.md), upstream `1c4a1c1`. Host: i7-14700K, 96 GiB, RTX 5060 Ti + Intel iGPU, Windows 11, Chrome headless shell 152.0.7977.30, FFmpeg 8.0 (exact values in `environment.json`).
- Run: 10 fixtures × 3 variants × (1 cold + 5 warm) = 180 runs.
  - The variants are `producer-default`, `cli-local-default`, and the uninstrumented `producer-default.control`.
  - All cells exited 0. The idle gate refused no runs, and the host-safety guard did not abort.
  - Peak usage: 25 live `chrome-headless-shell` processes, at least 46.6 GiB of RAM free, and 57.2 GiB committed. After the run, 0 tracked processes were left (`run-manifest.json → guard`).
  - Runs are interleaved per fixture: each variant's cold run comes first, then warm rounds A,B,C,A,B,C…, with the order rotating by fixture + run (`interleavedSchedule` in `benchmarks/src/run-benchmark.ts`).
- Every number below comes from `adr-facts.json`, which `benchmarks/src/adr-facts.ts` produces from `summary.json`, `runs.csv` and `raw/`. A range is the min-max across cells of warm medians unless stated otherwise. "(…, n=k)" names the cell at the upper bound and the number of cells in the range.

## Context

PR00 measures unmodified upstream before any acceleration work.

- `producer-default` uses the API defaults: software browser GPU (SwiftShader, by design: `packages/engine/src/config.ts:295`) and screenshot capture.
- `cli-local-default` behaves like a local `hyperframes render`: `--browser-gpu auto`, with no forced screenshot.

## Superseded runs and what invalidated them

Two earlier full baselines on this host are **withdrawn**:

- `2026-10-26-1c4a1c1`: kept in git history up to `70a0d46`.
- An incomplete `2026-10-27` run: it froze the host, a hard reset was needed, and the run was never committed.

Both runs started their render workers without `windowsHide`, from a parent process that had no console.

- **Symptoms.**
  - Dozens of visible console windows appeared.
  - Each window belonged to a `chrome-headless-shell --type=utility --utility-sub-type=network.mojom.NetworkService` process failing with `0x800700e8` (`ERROR_NO_DATA`, the pipe to its parent already closed).
  - Upstream logged `Auto-worker calibration failed` with error `Network.enable timed out` (protocolTimeout 30000) on **61 of 61** non-webm streaming runs.
  - In 21 of 24 SDR cells, the warm runs used two different pipelines.
  - `cli-local-default` resolved `--browser-gpu auto` to **SwiftShader** (`gpuRenderer: swiftshader/other`).
- **Change.** Against the withdrawn `2026-10-26` run, the harness changed three things at once. Upstream, fixtures and settings stayed identical.
  - Every worker now gets a hidden console (`windowsHide: true`), which Chrome and FFmpeg inherit.
  - A settle wait and cooldown run before every run.
  - The PID-tracked tree kill and the resource guards were added (*Host safety* in `docs/benchmark-protocol.md`).

  The incomplete `2026-10-27` run and the visible-console diagnostic already had the settle wait, and both still failed. The diagnostic failed even in its fresh-process + settle mode, with no render child alive. Settle alone is therefore ruled out. Hiding the console and the tree kill were not separated: no run used one without the other.
- **Result** (same host, same upstream SHA, same fixtures):

  | | Visible consoles (withdrawn) | Hidden consoles (this run) |
  |---|---|---|
  | Calibration failures | 61 of 126 SDR non-webm runs | **0 of 180** (`calibrationFailures`) |
  | Cells with mixed capture path | 21 of 24 SDR | **0 of 24** (`mixedCellCount`) |
  | `cli-local-default` GPU | `swiftshader/other` | hardware: probe → hardware in 10 of 10 worker probes (6 Intel, 4 NVIDIA adapter strings); every run that records `gpuRenderer` shows `d3d11/intel` |
  | Disk-path warm wall | 24.3-37.8 s | **9.9-24.3 s** (`diskPathWallMs`) |
  | Calibration diagnostic, 4 modes × 6 renders (`diagnostics/`) | **11 of 24** failed, in every mode, including fresh process + settle wait + no render child alive (`sFsFsF`, `sFFFFs`, `FsssFs`, `sssFsF`) | **0 of 24** (`ssssss` in all four modes) |

- **Conclusion.** The calibration timeouts, the per-run pipeline flips and the SwiftShader fallback of `--browser-gpu auto` were caused by the harness's process setup on this host, not by upstream. The A/B above shows this. Upstream was held fixed; the harness changes are confounded with each other as described under *Change*. The most direct evidence for the console is the diagnostic. In it, the same procedure with settle on failed 11 of 24 runs with visible consoles and 0 of 24 with hidden consoles, while the tree kill had nothing to clean up.
- **What is not proven.** The exact Windows-side mechanism is still a hypothesis. It is consistent with a new console (conhost) created per Chrome child process, slowing or breaking utility-process start-up until a 30 s CDP call times out. The A/B demonstrates the effect, not the mechanism.
- **Upstream exposure.** This is still worth reporting upstream. Puppeteer launches Chrome without `windowsHide`, so a HyperFrames render started from a console-less parent on Windows (a service, a scheduler, a GUI app) can be exposed to the same failure.

## What was measured

1. **The pipeline is stable.**
   - All 105 SDR warm disk-path runs used 5 workers (`diskPathWorkers`). The 15 streaming runs are webm-transparency, which always streams, with 1 worker.
   - Upstream calibration succeeded on every run (`calibrationVsPath`: disk 126, streaming 18, hdr_layered 36, all `calibrationFailed=false`).
2. **SDR always captures with `Page.captureScreenshot`.** BeginFrame is Linux-only. drawElement is clamped as `software_gpu` under producer-default and as `parallel` under the CLI profile (`drawElementClampReasons`).
3. **Capture dominates SDR wall time.**
   - Capture is **92.3-98.0 %** of wall time (`sdrCaptureShareOfWall`).
   - Disk-path setup is **2.2-8.1 s** (mixed-complex/cli-local-default, n=21 disk cells). It never exceeds the frame-capture time (`diskSetupExceedsFrames`: 0 of 14).
   - Disk-path frame capture is **7.3-15.5 s** (mixed-complex/producer-default, n=21).
   - Screenshot RPC p50 is **32-94 ms** (css-filters-blend/producer-default, n=15).
4. **Stage overlap.**
   - On the disk path, capture → encode is serial (overlap 0). SDR encode is 0.10-6.4 s.
   - Self-encoding stages (`capture_streaming`, `capture_hdr_layered`) emit no `encode` event. Their encode interval is rebuilt from `stages.encodeMs`, aligned to the end of capture (`inferredPhases`).
   - Concurrency is **1.00-1.98×** across all cells (n=20) and **1.87-1.98×** among the 6 cells with an inferred encode.
5. **Throughput.**
   - SDR renders at **0.30-0.86×** real time (gsap-static-holds/producer-default, n=16).
   - HDR renders at **0.062-0.178×** real time (1.85-5.35 fps, n=4).
6. **Frame bytes over CDP.**
   - SDR frame-RPC responses carry 12.5-724 KiB per frame.
   - HDR frame pixels do **not** cross CDP. One render moves 5.8-8.7 MiB in and 33.1-36.1 MiB out over CDP, while **7.00-8.79 GiB** is written to disk. Native HDR frames are pre-extracted by FFmpeg and composited in Node (`packages/producer/src/services/renderOrchestrator.ts:4551-4555`).
7. **CPU.** HDR takes 320-500 CPU-seconds per render. SDR takes 4.3-119 CPU-seconds (canvas-webgl/producer-default, n=16).
8. **Media extraction.** Cold `video_extract` takes 0.23-1.41 s. Warm runs hit the cache and take 3-6 ms.
9. **Memory.**
   - Peak working set of the process tree is 658-7 385 MiB (video-heavy/cli-local-default, n=20).
   - Peak ΔVRAM is 0-1 234 MiB (css-filters-blend/cli-local-default). This is device-level, so it includes other GPU users on the desktop.
10. **Profiles.**
    - With the pipeline now stable, `cli-local-default` is slower than producer-default in 9 of 10 fixtures, by +0.2 % to +14.8 % (`cliVsProducer`).
    - The exception is webm-transparency, where it is 18.5 % faster.
    - Under `auto`, ANGLE often picked the **Intel iGPU** rather than the RTX 5060 Ti: the probe reported Intel in 6 of 10 workers, and every run that records `gpuRenderer` shows `d3d11/intel`. Which adapter ANGLE picks is a confounder for any GPU-mode comparison on this host.
11. **Cost (estimate).**
    - Measured: 130-5 004 CPU-seconds per output minute.
    - At the labelled reference rate (AWS c7i.xlarge us-east-1, $0.0446/vCPU-h, 2025 list price; override with `BENCH_USD_PER_VCPU_HOUR`) this is about $0.0016-$0.062 per output minute. It is not a measured bill.

### Harness overhead

All 10 instrumented/control pairs ran on the same capture path, with 5 warm runs on each side (`pathMatchedOverheadPct`). The difference between warm medians is **−1.6 % to +6.5 %** (canvas-webgl/producer-default, n=10).

- 7 of the 10 pairs fall within ±3.2 %.
- The two largest are canvas-webgl (+6.5 %) and mixed-complex (+6.1 %). Both are the per-frame-heaviest SDR fixtures, which fits CDP-tap cost per message.
- Cold runs: −3.8 % to +4.8 %.

The instrumentation therefore costs up to about 6.5 % on the heaviest fixtures. Comparisons between experiments must use the same instrumentation level.

## Ranked bottlenecks (this host, this run)

| Rank | Bottleneck | Evidence |
|---|---|---|
| 1 | Per-frame screenshot capture (SDR) | 92-98 % of wall; frames 7.3-15.5 s; RPC p50 32-94 ms; up to 724 KiB/frame over CDP |
| 2 | HDR layered path | 0.062-0.178× real time; 7.00-8.79 GiB written; 320-500 CPU-s per render |
| 3 | Disk-path capture setup | 2.2-8.1 s per render |
| 4 | Serial capture → encode on the disk path | overlap 0; bounded by encode, 0.10-6.4 s |
| 5 | Media extraction | ≤ 1.41 s cold, ≤ 6 ms warm |

**HDR hypotheses (untested):** the cost may come from disk staging of pre-extracted `rgb48le` frames, from Node-side CPU compositing/conversion, or from both. There is no substage timing inside `capture_hdr_layered` yet.

## Options compared

| Investment | Upside indicated by data | Risk | Decision |
|---|---|---|---|
| **Per-frame capture** (lower-latency frame source; lift the drawElement `parallel` clamp under a flag) | Rank 1 on every SDR fixture | Fidelity vs the Chromium reference | **First**, behind a flag with screenshot fallback and PR01 gates |
| **HDR pipeline** | Largest per-fixture headroom | PQ/HLG correctness | **Second**: instrument the substages first |
| **Setup cost** (calibration/browser pool warm-up) | 2.2-8.1 s per render; matters most for short clips | Worker-budget changes can cause OOM/timeouts | Third |
| **Encode overlap / GPU encode** | Bounded by encode time on the disk path | NVENC quality drift | Deferred |
| **Media decode / extraction** | ≤ 1.41 s cold, cache makes warm free | Low | Deferred; revisit with longer or higher-resolution media |
| ~~Calibration reliability~~ | Ranked first in the withdrawn runs | n/a | **Dropped**: the failures were a harness artefact (see *Superseded runs*). Filing the Windows console exposure upstream is a follow-up, not an acceleration investment |

## Decision

1. Work on per-frame SDR capture first, then HDR. Each step goes behind a feature flag with a fail-closed fallback.
2. Every experiment is measured with this harness and must pass the PR01 fidelity gates. That means paired runs, interleaved per run, ≥ 5 warm runs, max reported as "max (n=5)", and the capture path, worker count and GPU renderer recorded per run.
3. A comparison is valid only within the same capture path and the same GPU adapter.
4. Before a full baseline on any host, the harness must pass the one-fixture smoke and fault-injection check in `docs/benchmark-protocol.md` (*Host safety*).

## Consequences

- One Windows host only. macOS, Linux BeginFrame, Linux SwiftShader and Docker are **not tested**.
- Benchmark numbers for HyperFrames on Windows depend on how the render process was started (with or without a visible console). Any published Windows number must say how.
- `--browser-gpu auto` on a hybrid-GPU host can pick the integrated GPU. GPU-mode experiments must pin and record the adapter.
- The harness is additive (`benchmarks/`, `docs/`) and does not change upstream behaviour. To roll it back, revert the PR.
