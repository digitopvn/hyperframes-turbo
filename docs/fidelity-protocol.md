# Fidelity protocol

Every experimental backend must prove that its output matches the **Chromium
reference backend** (unmodified upstream, `producer-default`) before any speed
claim counts. This document defines the gate, how thresholds are calibrated,
and how to run both. The design rationale is in
[ADR 0002](adr/0002-fidelity-gates.md).

Code: `benchmarks/src/fidelity/`. Tests: `benchmarks/test/fidelity/`.

## Verdicts and exit codes

| Verdict | Meaning | `run-fidelity.ts` exit |
|---|---|---:|
| PASS | Every applicable check ran and stayed inside its calibrated limit. | 0 |
| FAIL | Any check failed, any measurement errored, thresholds are missing or invalid, or nothing applicable ran. | 1 |
| FALLBACK | No failure, but something could not be verified (VMAF unavailable, `TURBO_FIDELITY=off`). The caller must use the reference backend. | 3 |
| usage error | Bad arguments. | 2 |

The gate fails closed. An internal error exits 1, and so does an empty set of
checks. FALLBACK never counts as PASS. `TURBO_FIDELITY=off` records
`FALLBACK/DISABLED`; it never records PASS. Every failure carries machine-readable
reasons (`REASONS` in `verdict.ts`), for example `FRAME_DROPPED`, `AV_DRIFT`,
`HDR_METADATA_MISMATCH` or `THRESHOLD_MISSING`.

## What is compared

All checks work on **decoded** output: FFmpeg decodes both files, and
VP8/VP9 is decoded with libvpx so the alpha plane is included.

| Check | Measurement | Rule |
|---|---|---|
| dimensions | width, height, SAR, codec, pix_fmt | exact |
| frameCount | decoded frames | exact |
| timestamps | `r_frame_rate` against the declared rational fps; each frame's PTS against `i / fps` in exact BigInt ticks; PTS/DTS monotonicity and DTS ≤ PTS; VFR (more than one distinct frame interval, ±1 tick) | exact. PTS error may not exceed the reference's own error, or 1 tick |
| temporal | 64×36 grey thumbnail of **every** frame, aligned against the reference | Classifies dropped, duplicated, reordered and stale frames. The match tolerance is calibrated |
| pixels | Full-frame MSE, PSNR, luma SSIM, max \|diff\| and diff-pixel % on sampled frames, at native bit depth (`rgb48le`/`rgba64le` for >8-bit) | calibrated |
| audio | Stream format; envelope cross-correlation in up to 3 transient windows (A/V offset); duration; residual | Format exact. Drift and duration are calibrated, with a floor of one codec frame (AAC 1024 samples, Opus 20 ms) |
| alpha | Alpha plane present (pix_fmt or libvpx-decoded plane, never container tags); alpha MSE on sampled frames | presence exact, MSE calibrated |
| color | transfer, primaries, matrix, range; mastering display and content light metadata | exact |
| encoded | Full-sequence PSNR and SSIM (FFmpeg `psnr`/`ssim`, worst frame); VMAF worst frame (SDR without alpha only); bitrate | calibrated |

VMAF is never the only gate. It is skipped as *not applicable* for HDR and
alpha, because its model is trained on SDR natural video. For graphics, PSNR,
SSIM and exact pixel statistics carry the decision.

### Sampled frames

`sample-plan.ts` builds a deterministic plan. Its seed comes from the
fixture source hash and the render settings, so every backend and every run
compares the same frames:

- the first and last frame;
- for every cut (each `data-start` and `data-start + data-duration` in the
  composition, root excluded), the frame before, at and after it;
- for each probe in `fidelity-manifest.json`:
  - `transition`: the first, middle and last frame;
  - `rapid-motion`: the probe frame and the one after it;
  - `opacity-boundary`, `filter-heavy`: the probe frame;
  - `motion-blur`: the probe frame and both neighbours;
  - `static-hold`: the first and last held frame and the frame after the hold;
- 8 seeded random frames.

The temporal check covers every frame regardless of sampling. The fault test
`pixel-corruption-unsampled` checks that the full-sequence encoded metrics
catch a corrupt frame that pixel sampling missed.

## Calibration

There are no universal cut-offs. Thresholds belong to a **path**, written
`<profile>.<platform>` (for example `producer-default.win32` or
`producer-default.linux`), and to a fixture:

1. Render the reference **at least 5 times**, warm, and keep the outputs:
   `run-benchmark.ts --fixture-set all --profiles producer-default --no-control --warm-runs 5 --keep-output`.
2. Run `calibrate.ts --results <dir>`. It measures every warm pair (10 pairs
   for 5 runs) with the same code the gate uses, and writes two files:
   - `benchmarks/fidelity/calibration/<path>.pairs.json`: all raw pair data,
     including unfavourable pairs, plus cold-vs-warm pairs kept separately for
     information;
   - `benchmarks/fidelity/thresholds/<path>.json`: the limits.
3. Limit rule, per metric:
   - all pairs identical: the limit is exact;
   - otherwise: worst observed value ± max(3 × MAD, metric resolution);
   - A/V drift and audio duration are never tighter than one audio codec
     frame.

A fixture whose reference renders disagree on a hard invariant (frame count,
geometry, codec, fps, timestamps, audio format) gets **no** thresholds. The
gate then fails closed for that fixture with `THRESHOLD_MISSING`.

## Running the gate

```bash
# Pair mode
node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs \
  benchmarks/src/fidelity/run-fidelity.ts --fixture <id> --ref <file|png dir> --cand <file|png dir> \
  [--path producer-default.win32] [--backend <name>] [--out record.json]

# Results mode: outputs kept by run-benchmark --keep-output
node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs \
  benchmarks/src/fidelity/run-fidelity.ts --results <dir> \
  --ref-cell producer-default --ref-run 1 --cand-cell <cell> --cand-run 2
```

Results mode writes `fidelity-report.{json,md}` into the results directory. It
also attaches a `turbo-fidelity/1` record to each candidate raw run, which
upgrades that run to `turbo-bench-run/2`. `report.ts` reads both `/1` and `/2`
and adds a Fidelity table.

Environment:

- `TURBO_FIDELITY=off`: disable the gate (records FALLBACK).
- `FIDELITY_DISABLE_VMAF=1`: skip VMAF (FALLBACK on SDR paths).
- `FIDELITY_FFMPEG` / `FIDELITY_FFPROBE`: tool paths.

All FFmpeg and ffprobe processes go through `fidelity/proc.ts`. It starts them
with `windowsHide`, allows at most 3 at once, kills the whole tree on timeout,
and kills every child still alive when the gate exits.

## Fault injection

`inject-faults.ts --results <dir>` takes kept reference outputs. It first
checks that an unmodified control passes. It then injects each applicable fault
into a copy and requires a FAIL carrying the expected reason:

- dropped, duplicated, reordered and stale frames;
- pixel corruption on a sampled frame and on an unsampled frame;
- wrong resolution, wrong fps and VFR timestamps;
- bitrate drop;
- alpha stripped and HDR metadata stripped;
- audio offset of 40 ms and missing audio.

Every row is written to `benchmarks/fidelity/negative-results/<path>.{json,md}`,
misses included. The gate test (`gate.test.ts`) runs the same faults on
synthetic SDR, VP9-alpha and HEVC-PQ media, so CI covers them without Chrome.

## CI

`.github/workflows/fidelity.yml` runs on ubuntu-24.04 with SwiftShader, for
**correctness only**. Shared runners and a software GPU make its timings
meaningless as benchmarks. It pins:

- FFmpeg 6.0.1 static (sha256-verified);
- Chrome headless shell;
- Bun and Node.

The job:

1. runs the tests;
2. renders a fixture subset (1 cold + 2 warm);
3. gates warm run 2 against warm run 1 with the committed
   `producer-default.linux` thresholds;
4. runs fault injection.

Adding the PR label `fidelity-calibrate` re-derives the Linux thresholds from
5 warm renders and commits them to the PR branch.

Platforms other than the ones with a committed threshold file are **not
tested**.
