# ADR 0001: Measured baseline bottlenecks and where to invest first

- Status: Proposed (PR00)
- Date: 2026-10-27
- Evidence: [`benchmarks/results/2026-10-26-1c4a1c1/`](../../benchmarks/results/2026-10-26-1c4a1c1/report.md), upstream `1c4a1c1`. Host: i7-14700K, 96 GiB, RTX 5060 Ti, Windows 11, Chrome headless shell 152.0.7977.30, FFmpeg 8.0 (exact values in `environment.json`).
- Run: 10 fixtures × 3 variants × (1 cold + 5 warm) = 180 runs.
  - The variants are `producer-default`, `cli-local-default`, and the uninstrumented `producer-default.control`.
  - All cells exited 0, and the idle gate refused no runs.
  - Runs are interleaved per fixture: each variant's cold run comes first, then warm rounds A,B,C,A,B,C… with the order rotating by fixture + run. The code is `interleavedSchedule` in `benchmarks/src/run-benchmark.ts`.
- Every number below is taken from `adr-facts.json`, which `benchmarks/src/adr-facts.ts` produces from `summary.json` and `runs.csv`. A range is a min-max across cells of warm medians, unless stated otherwise.

## Context

PR00 measures unmodified upstream before any acceleration work.

- `producer-default` runs with the API defaults: software browser GPU and screenshot capture.
- `cli-local-default` runs like a local `hyperframes render`: `--browser-gpu auto` and no forced screenshot.

## What was measured

1. **Upstream calibration decides the pipeline per run, and it flips.** In 21 of 24 SDR cells, the warm runs of a single cell used two different pipelines (`mixedPathCells`). The three cells that did not flip are webm-transparency, which always streams.
   - **Calibration fails, so upstream falls back to streaming with 1 worker.** Upstream logged `Auto-worker calibration failed; using conservative worker budget` in **61 of 61** non-webm streaming runs and in **0 of 65** disk runs (`calibrationVsPath`).
     - Calibration runs under a 30 s CDP protocol ceiling: `CAPTURE_CALIBRATION_PROTOCOL_TIMEOUT_MS` (`packages/producer/src/services/render/captureCost.ts:63`), with the fallback at `captureCost.ts:441-442`.
     - Setup on these runs is **35.1 s** (35 106-35 142 ms), and wall time is **56.0-85.7 s**.
   - **Calibration succeeds, so upstream uses the disk path with 5 workers.** Setup is **8.0-22.2 s**, and wall time is **24.3-37.8 s**.
   - The setup distribution is bimodal, and the mode depends only on this calibration decision.
   - Pooled medians in mixed cells mix two pipelines, so the report gives a separate distribution per path (*Mixed capture path* section).
   - Why calibration times out on some runs and not on others is **not determined**.
2. **SDR always captures with `Page.captureScreenshot`.** BeginFrame is Linux-only. drawElement is clamped as `software_gpu` under producer-default and as `parallel` under the CLI profile.
3. **Stage overlap.**
   - On the disk path, capture → encode is serial (overlap 0).
   - Self-encoding stages (`capture_streaming`, `capture_hdr_layered`) emit no `encode` event. Their encode interval is rebuilt from `stages.encodeMs`, aligned to the end of capture (`inferredPhases`).
   - Concurrency across all cells is **1.00-1.99×**. Among cells with an inferred encode it is **1.36-1.99×**.
4. **Throughput.**
   - On the SDR disk path, per-path wall times are listed above.
   - HDR runs at **0.058-0.163×** real time (1.75-4.87 fps).
   - Screenshot RPC p50 is 32-88 ms.
5. **Frame bytes over CDP.**
   - SDR frame-RPC responses carry 12.5-724 KiB per frame.
   - HDR frame pixels do **not** cross CDP. One render moves 5.8-8.6 MiB in and 33.1-36.1 MiB out over CDP, while **7.00-8.41 GiB** is written to disk. Native HDR frames are pre-extracted by FFmpeg and composited in Node (`packages/producer/src/services/renderOrchestrator.ts:4551-4555`).
6. **HDR CPU.** 331-521 CPU-seconds per render.
7. **Media extraction.** Cold `video_extract` takes 0.23-1.39 s. Warm runs hit the cache and take 3-7 ms.
8. **Memory.**
   - Peak working set of the process tree is 578-5 178 MiB.
   - Peak ΔVRAM is 0-5 MiB, which is too small to support any GPU-memory claim.
9. **Profiles.** The CLI-vs-producer differences (`cliVsProducer`) are confounded by how many runs of each cell hit the calibration fallback. This run does not support any conclusion about the profiles themselves.
10. **Cost (estimate).**
    - Measured: 112-5 209 CPU-seconds per output minute (pooled over paths).
    - At the labelled reference rate (AWS c7i.xlarge us-east-1, $0.0446 per vCPU-h, 2025 list price, override with `BENCH_USD_PER_VCPU_HOUR`) this is about $0.0014-$0.065 per output minute. It is not a measured bill.

### Harness overhead: not resolved

The harness overhead could **not** be resolved from this run.

- **Path-matched comparison** (`pathMatchedOverheadPct`) compares instrumented and control runs on the same capture path. Warm-median differences range from **−35.8 % to +11.0 %**, with only 1-5 runs on each side, and the sign is not consistent.
- **Stable cells with a single path:**

| Cell | Warm Δ | Control cv | Instrumented cv |
|---|---|---|---|
| hdr-hlg | +1.6 % | 1.9 % | 0.6 % |
| hdr-regression | +2.1 % | 1.8 % | 0.6 % |
| webm-transparency | −5.7 % | 4.4 % | 2.0 % |

These differences are of the same order as the cv. No overhead bound is claimed.

## Ranked bottlenecks (this host, this run)

| Rank | Bottleneck | Evidence |
|---|---|---|
| 1 | Calibration timeout → conservative 1-worker streaming fallback | 61 of the non-webm SDR runs; 35.1 s setup; wall 56.0-85.7 s against 24.3-37.8 s when calibration succeeds |
| 2 | Disk-path setup + per-frame screenshot capture | setup 8.0-22.2 s; RPC p50 32-88 ms |
| 3 | HDR layered path | 0.058-0.163×; 7.00-8.41 GiB written; 331-521 CPU-s per render |
| 4 | Serial capture → encode on the disk path | overlap 0; bounded by the encode time |
| 5 | Media extraction | ≤ 1.39 s cold, ≤ 7 ms warm |

**HDR hypotheses (untested):** the cost may come from disk staging of pre-extracted `rgb48le` frames, from Node-side CPU compositing/conversion, or from both. There is no substage timing inside `capture_hdr_layered` yet.

## Options compared

| Investment | Upside indicated by data | Risk | Decision |
|---|---|---|---|
| **Calibration reliability** (find why calibration hits the 30 s ceiling; a cheaper or cached calibration) | Removes the ~2-3× fallback penalty on any run that hits it | Changing worker budgeting can cause OOM or timeouts; needs a fail-closed fallback | **First**: diagnose before changing anything |
| **Per-frame capture** (lower-latency frame source; lift the drawElement `parallel` clamp under a flag) | Rank 2 on every SDR fixture | Fidelity vs the Chromium reference | **Second**, behind a flag with screenshot fallback and PR01 gates |
| **HDR pipeline** | Largest per-fixture headroom | PQ/HLG correctness | **Third**: instrument the substages first |
| **Media decode / extraction** | ≤ 1.39 s cold, cache makes warm free | Low | Deferred; revisit with longer or higher-resolution media |
| **Encode overlap / GPU encode** | Bounded by encode time on the disk path | NVENC quality drift | Deferred |

## Decision

1. Diagnose upstream calibration failures first: when and why the 30 s ceiling is hit. Report it upstream if it is a defect.
2. Then work on per-frame SDR capture, then HDR. Each step is behind a feature flag with a fail-closed fallback.
3. Every experiment is measured with this harness and must pass PR01 fidelity gates. That means paired, per-run interleaved, ≥ 5 warm runs, max reported as "max (n=5)", and the capture path recorded per run.
4. A comparison is valid only within the same capture path.

## Consequences

- One Windows/NVIDIA host only. macOS, Linux BeginFrame, Linux SwiftShader and Docker are **not tested**.
- Because the calibration decision varies per run, a benchmark that reports pooled medians without the capture path can show large spurious differences. The harness now records the path and flags mixed cells.
- The harness is additive (`benchmarks/`, `docs/`) and does not change upstream behaviour. To roll it back, revert the PR.
