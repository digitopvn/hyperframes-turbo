# ADR 0001: Measured baseline bottlenecks and where to invest first

- Status: Proposed (PR00)
- Date: 2026-10-27
- Evidence: [`benchmarks/results/2026-10-26-1c4a1c1/`](../../benchmarks/results/2026-10-26-1c4a1c1/report.md), upstream `1c4a1c1`. Host: i7-14700K, 96 GiB, RTX 5060 Ti, Windows 11, Chrome headless shell 152.0.7977.30, FFmpeg 8.0 (exact values in `environment.json`).
- Run: 10 fixtures × 3 variants (`producer-default`, `cli-local-default`, uninstrumented `producer-default.control`) × (1 cold + 5 warm) = 180 runs. All cells exited 0, and the idle gate refused no runs. Variant order rotates per fixture.
- Every number below is copied from `adr-facts.json`, which `benchmarks/src/adr-facts.ts` computes from `summary.json`. Ranges are min-max across cells of the warm median, unless a range is marked as cold or max.

## Context

PR00 measures unmodified upstream before any acceleration work.

- `producer-default` uses the API defaults: software browser GPU, which clamps capture to screenshot.
- `cli-local-default` matches a local `hyperframes render`, with `--browser-gpu auto` and no forced screenshot.

## What was measured

1. **SDR capture is always `Page.captureScreenshot`.** The capture mode is screenshot in both profiles, with path `disk` or `streaming` (webm-transparency and audio-mix/cli).
   - drawElement is clamped as `software_gpu` under producer-default and as `parallel` under the CLI profile.
   - BeginFrame is Linux-only, so neither upstream fast-capture path runs on this host at the defaults.
2. **Capture dominates SDR wall time.** It takes **97.1-98.8 %** of the warm median wall time.
   - Within capture, warm `captureSetupMs` (calibration) ranges from 5 ms (webm streaming) to **33.1 s** (mixed-complex/cli).
   - On the disk path, setup exceeds frame-capture time in 9 of 15 cells (see the stage table).
3. **Stage overlap depends on the capture path.**
   - **Disk path:** capture → encode is strictly serial (overlap 0 ms, concurrency 1.00×). SDR encode takes 0.10-0.80 s on this path.
   - **Self-encoding stages** (`capture_streaming`, `capture_hdr_layered`): upstream emits no `encode` trace event. The harness therefore rebuilds the encode interval from `stages.encodeMs`, aligned to the end of capture (`inferredPhases`). On that basis encode overlaps capture almost entirely:
     - concurrency is 1.82-1.98×;
     - overlap is up to 96.1 s on hdr-regression and 10.0 s on webm-transparency.
     - Earlier drafts claimed "no stage overlap anywhere". That was wrong.
4. **Throughput is far below real time.**
   - SDR warm render factor is **0.13×** (canvas-webgl/cli) to **0.46×** (typography-svg/producer).
   - HDR is **0.059×** (1.77 fps, hdr-regression/producer) to **0.167×** (5.0 fps, hdr-hlg/cli).
   - Screenshot RPC p50 is 32-94 ms per call, with 5 workers.
5. **Frame bytes over CDP.**
   - **SDR:** responses from frame RPCs carry 12.5-724 KiB per frame.
   - **HDR:** frame pixels do **not** cross CDP. Totals per render are 5.8-8.6 MiB in and 33.1-36.1 MiB out, against **7.00-8.41 GiB** written to disk.
     - Native HDR video frames are pre-extracted by FFmpeg and composited in Node (`packages/producer/src/services/renderOrchestrator.ts:4551-4555`, `captureHdrStage.ts:276` `rgb48le`).
     - Earlier drafts quoted ~41 KiB/frame "readback" for HDR. That figure was only the DOM-layer screenshots.
6. **HDR CPU and disk.** An HDR render costs 330-557 CPU-seconds, against 4.3-117 for SDR.
7. **Media extraction.**
   - Cold `video_extract` takes 0.23-**1.40 s** (video-heavy/cli).
   - Warm runs hit the extraction cache, so extraction drops to 3-10 ms.
8. **Memory.**
   - Peak working set of the process tree is **0.58-5.88 GiB** (597 MiB webm-transparency/cli to 6 025 MiB video-heavy/producer).
   - Peak ΔVRAM is 1-895 MiB (largest on canvas-webgl/cli).
9. **Profiles.** `cli-local-default` was slower than producer-default on 5 of 10 fixtures, by up to +30 % (canvas-webgl), and faster on video-heavy by −10 %. The full table is in `adr-facts.json → cliVsProducer`.
10. **Cost (estimate).**
    - Measured: 128-5 570 CPU-seconds per output minute.
    - At the labelled reference rate (AWS c7i.xlarge us-east-1, $0.0446 per vCPU-h, 2025 list price, overridable with `BENCH_USD_PER_VCPU_HOUR`), that is about $0.0016-$0.069 per output minute.
    - This is an estimate, not a measured bill.

### Harness overhead

The uninstrumented control (`overhead.csv`) shows warm-median differences between −13.3 % and +8.7 %, and cold differences between −38.6 % and +15.0 %. The sign is inconsistent, and the largest values sit in cells whose own cv is 20-37 % (mixed-complex, audio-mix). Overhead therefore cannot be resolved above host noise.

On the low-noise cells the differences are small:

| Cell | Warm Δ | cv |
|---|---|---|
| hdr-hlg | +1.5 % | 0.3 % |
| hdr-regression | +0.9 % | 0.8 % |
| webm-transparency | +0.9 % | 1.6 % |

Our best measured bound is therefore about ≤ 2 % on stable cells. This is not a guarantee for the noisy ones.

### Variance and run-to-run drift

- Five cells have warm cv > 10 %: audio-mix ×2, mixed-complex ×2 and webm-transparency/cli. The report lists every run in them.
  - In the audio-mix and mixed-complex cells, the variance is entirely in `captureSetupMs`: 7.7 s to 35 s within a single cell.
  - The idle gate passed on its first attempt for all of those runs.
- **Drift against the previous run of the same commit (2026-10-26, unpublished):** warm setup medians were then 2.6-7.0 s. They are now 5.8-33 s, and frame time is also higher (typography-svg/producer 11.4 s, previously ~8.0 s).
  - Host, fixtures and upstream are identical.
  - No leftover Chrome or FFmpeg processes were found afterwards.
  - The cause is not identified. It is a host-state effect that the CPU/GPU idle gate does not detect, for example thermal/power state or disk.
- The previous run's typography-svg/producer warm run 3 outlier (17.4 s against an 11.1 s median) had the same signature: setup 7.9 s against ~2.6 s, and 14 idle-gate attempts.
- **Consequence:** absolute setup numbers from this host are not stable. Comparisons must be paired and interleaved in the same session, as this harness does. PR01 should add disk and power-state sampling to the gate.

## Ranked bottlenecks (this host, this run)

| Rank | Bottleneck | Evidence |
|---|---|---|
| 1 | Capture setup/calibration fixed cost (SDR) | Up to 33 s per render; the largest and most variable stage; larger under hardware auto |
| 2 | Per-frame screenshot capture (SDR) | 97-99 % of wall time is capture; RPC p50 32-94 ms; render factor 0.13-0.46× |
| 3 | HDR layered path | 0.06-0.17× real time; 7.0-8.4 GiB written to disk and 330-557 CPU-s per render; encode already overlaps capture (≈1.95×) |
| 4 | Serial capture → encode on the disk path | Overlap 0, but encode is only 0.10-0.80 s, so the gain is bounded |
| 5 | Media extraction | ≤ 1.4 s cold, ≤ 10 ms warm (cached) |

**HDR hypotheses (not yet tested):** the HDR cost may come from the disk staging of pre-extracted `rgb48le` frames, from Node-side compositing/conversion on the CPU, or from both. That reading is consistent with ~8 GiB of writes, high CPU-seconds and tiny CDP traffic. It is not proven: no per-substage timing exists inside `capture_hdr_layered`. PR01 or the HDR investigation must instrument that stage before choosing a fix.

## Options compared

| Investment | Upside indicated by data | Risk | Decision |
|---|---|---|---|
| **Capture setup + per-frame capture** (find why calibration/setup costs seconds; a lower-latency frame source than `captureScreenshot`; lift the drawElement `parallel` clamp under a flag) | Ranks 1-2 on every SDR fixture | Fidelity vs Chromium reference; platform-specific | **First**, behind a feature flag with screenshot fallback and PR01 fidelity gates. Profile the setup stage first. |
| **HDR pipeline** | Largest per-fixture headroom | PQ/HLG metadata and colour correctness; small user base | **Second**, after instrumenting substages inside `capture_hdr_layered` |
| **Media decode / extraction** | ≤ 1.4 s cold on these fixtures, and the cache makes warm runs free | Low | **Deferred**: under 3 % of cold wall time here. Revisit with longer or higher-resolution source media. |
| **Encode overlap / GPU encode** | ≤ 0.8 s on the disk path; streaming paths already overlap | NVENC quality drift | Deferred |
| **Scene cache** | Warm reuse is limited to extraction today | Invalidation correctness | Later: needs an incremental-rerender fixture |

## Decision

1. Invest first in SDR **capture**, starting with a profile of the setup/calibration stage and then the per-frame source.
2. Invest second in **HDR**, starting with instrumentation, not with a fix.
3. Every experiment is measured with this harness (paired, interleaved, ≥ 5 warm runs, max reported as "max (n=5)") and must pass the PR01 fidelity gates.

## Consequences

- These results hold for a single Windows/NVIDIA host. macOS, Linux BeginFrame, Linux SwiftShader and Docker were **not tested**.
- The run-to-run drift above means the absolute numbers are not portable, even across sessions on this host.
- The harness is additive (`benchmarks/`, `docs/`) and leaves upstream behaviour unchanged. To roll it back, revert the PR.
