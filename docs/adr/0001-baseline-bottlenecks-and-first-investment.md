# ADR 0001: Measured baseline bottlenecks and where to invest first

- Status: Proposed (PR00)
- Date: 2026-10-27
- Evidence: [`benchmarks/results/2026-10-26-1c4a1c1/`](../../benchmarks/results/2026-10-26-1c4a1c1/report.md), upstream `1c4a1c1`. Host: i7-14700K, 96 GiB, RTX 5060 Ti (driver 610.88), Windows 11, Chrome headless shell 152.0.7977.30, FFmpeg 8.0. The run covered 10 fixtures × 2 profiles × (1 cold + 5 warm). All 120 runs succeeded, and 0 were refused by the idle gate.

## Context

Before any acceleration work, PR00 measures where time and bytes go in unmodified upstream. Two profiles were measured:

- `producer-default`: the API defaults. The browser GPU is software, which clamps capture to screenshot mode.
- `cli-local-default`: what `hyperframes render` does locally, with `--browser-gpu auto` and no screenshot clamp.

## What was measured

1. **Every SDR fixture used `Page.captureScreenshot` in both profiles.** The CLI profile resolved hardware GPU, but drawElement was still clamped (`perfSummary.drawElement.clampReason = "parallel"` at 5 workers). BeginFrame is Linux-only. On this host neither upstream fast-capture path is in play at the defaults.
2. **Capture is the critical path for SDR.** `capture_calibration` → `capture_disk` covers 85-97 % of wall time in every SDR cell. For example, `mixed-complex` producer-default spends 3.1 s in setup and 14.7 s capturing frames out of 19.2 s. Encode stays under 0.9 s and runs after capture: `capturePath:"disk"`, concurrency factor 1.00, so there is no stage overlap anywhere.
3. **Throughput is far below real time.** Warm render factor ranges from 0.36× (canvas-webgl) to 0.87× (gsap-static-holds) for SDR. Per-frame screenshot RPC p50 is 45-96 ms, with 5 workers in parallel.
4. **Readback is real but not the binding cost for SDR.** It ranges from 80 to 724 KiB per frame (PNG/base64 through CDP): 127 MiB for 180 canvas frames and 125 MiB for 300 mixed frames. Spread over 10-15 s that is about 10 MiB/s, which is far below what CDP can move. Latency per screenshot call (raster + encode inside Chrome) is what dominates, not transport bytes.
5. **Capture setup is a large fixed cost.** Warm setup takes 2.6-3.3 s under software GPU and 3.4-7.0 s under hardware auto, which is 20-35 % of short renders. Hardware auto was *slower* in 8 of 10 fixtures, mainly because of setup; it was faster only on `webm-transparency` (−17 %) and `hdr-regression` (−2 %).
6. **HDR is the worst path by an order of magnitude.**
   - `hdr-regression` (PQ) runs at 1.9 fps (0.06×) and `hdr-hlg-regression` at 6 fps (0.20×). Upstream itself documents ~6 fps.
   - The `capture_hdr_layered` stage is the entire wall time. It writes 7.2-8.8 GiB to disk per render (process-tree I/O) and costs 320-525 CPU-seconds per render, against 27-120 s for SDR.
7. **Media decode is not a bottleneck on these fixtures.**
   - Cold `video_extract` takes 0.4-0.5 s.
   - Warm runs hit the extraction cache, so extraction drops to ~3-6 ms (cold 0 hits / 4 misses, warm 4 / 0 for `video-heavy`).
8. **Memory.** The peak process-tree working set is 2.6-6.0 GiB, with `video-heavy` producer-default the largest. ΔVRAM is about 0.1-0.7 GiB under software and up to 2.5 GiB under hardware auto.

### Outlier: typography-svg / producer-default warm run 3

- **What was measured:** wall time was 17.44 s against a median of 11.10 s, which gives this cell its 22 % cv. It was kept in the statistics.
- **Where the time went:** `captureSetupMs` was 7 859 ms versus about 2 630 ms in the other warm runs, while `captureFrameMs` was 9 249 ms versus about 8 000 ms. Encode was unchanged, there was one capture attempt and no retries, and screenshot RPC p95 was normal at 66 ms.
- **Host state:** before this run the idle gate needed **14 attempts** to pass (1-6 for the other runs). It passed at CPU 15 %, under the 20 % threshold, so the run is not flagged.
- **Interpretation:** a transient load on the host just before the run slowed browser/worker startup. It is contention-driven variance in setup, not a capture regression.
- **Consequence for PR01:** `idleAttempts` is now a `runs.csv` column, and PR01 should treat a cell with cv > 10 % as needing a rerun.

## Ranked bottlenecks (this host)

| Rank | Bottleneck | Evidence |
|---|---|---|
| 1 | HDR layered capture (float16 readback, disk staging, CPU conversion) | 0.06-0.20× real time; 7-9 GiB written and 320-525 CPU-seconds per render |
| 2 | Per-frame screenshot capture latency on SDR | 85-97 % of wall time on the critical path; 45-96 ms p50 per call |
| 3 | Capture setup/calibration fixed cost | 2.6-7.0 s per render, larger under hardware GPU |
| 4 | Serial capture → encode (disk path, no overlap) | concurrency factor 1.00, untraced ~70-125 ms; encode ≤ 0.9 s, so the gain is bounded |
| 5 | Media decode | ≤ 0.5 s cold, cached warm; not a bottleneck on these fixtures |

## Options compared

| Investment | Upside indicated by data | Risk | Decision |
|---|---|---|---|
| **Capture / transport** (frame source with lower latency than `captureScreenshot`; lift the drawElement `parallel` clamp under a flag; raw/shared-memory pixels instead of PNG/base64) | Largest SDR lever: it addresses ranks 2-3 on every SDR fixture | Fidelity vs the Chromium reference; platform-specific | **First**, behind a feature flag with fallback to screenshot, gated by PR01 fidelity checks |
| **HDR pipeline** (avoid base64 float16 readback, avoid staging GiB to disk, GPU conversion) | Largest per-fixture gain, up to 10× headroom to SDR speed | HDR metadata and colour correctness are hard to verify, and few users render HDR | **Second**, once PR01 can gate PQ/HLG metadata and colour |
| **Scene cache** (reuse unchanged frames across rerenders) | Static dedup never armed in the video fixtures (`video_injection`), and warm reuse is limited to extraction | Invalidation correctness | Later: needs an incremental-rerender fixture first |
| **Media decode** (GPU decode, NVDEC) | ≤ 0.5 s measured | Low | **Deferred**: no measured need |
| Encode overlap / GPU encode | Encode ≤ 0.9 s of SDR wall time | Quality drift with NVENC | Deferred; revisit after capture gets faster |

## Decision

1. Invest first in **capture/transport for SDR**: make the per-frame capture cost and the setup cost smaller.
2. Invest second in **HDR**.
3. Every experiment must be re-measured with this harness (paired, ≥5 warm runs) and pass the PR01 fidelity gates before it can claim anything.

## Consequences

- Every claim above holds for one Windows/NVIDIA host. macOS, Linux BeginFrame, Linux SwiftShader and Docker are **not tested**, and their ranking may differ. On Linux, BeginFrame changes rank 2 in particular.
- The harness is additive (`benchmarks/`, `docs/`) and does not change upstream behaviour. To roll it back, revert the PR.
