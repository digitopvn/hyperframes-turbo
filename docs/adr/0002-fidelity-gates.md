# ADR 0002: Fail-closed fidelity gates against the Chromium reference

- Status: Proposed (PR01)
- Date: 2026-10-27
- Method: [`docs/fidelity-protocol.md`](../fidelity-protocol.md). Code: `benchmarks/src/fidelity/`.
- Evidence: see *Measurements* below. Every number comes from a committed file.

## Context

Later PRs will add experimental backends: GPU capture, other encoders, zero-copy paths. Each must be proven to produce the same video as unmodified upstream before any of its speed is counted. `AGENTS.md` forbids silent downgrades of resolution, frame rate, audio, alpha, HDR, motion blur or quality.

PR00 only probed output metadata and deleted every output. Nothing compared decoded content.

Verified upstream facts (pinned `1c4a1c1`) that shaped the design:

| Question | Answer | Source |
|---|---|---|
| Lossless pre-encode export? | Yes: `format: "png-sequence"` writes `frame_%06d.png`, numbered from 1 | `packages/producer/src/services/render/renderFormat.ts`, `.../stages/assembleStage.ts` |
| Rational fps? | `meta.json` accepts `"30000/1001"`. `createRenderJob` does not parse strings, so the harness calls upstream `parseFps` | `packages/core/src/core.types.ts` |
| Motion blur? | `motionBlur?: MotionBlurOptions` (`samplesPerFrame`, `shutterAngle`, `shutterPhase`, `blend`), screenshot capture path | `packages/engine/src/types.ts:179` |
| Audio codec | MP4: AAC 192 kb/s (1024-sample frames). WebM: Opus 128 kb/s (20 ms frames) | `packages/engine/src/services/aacEncode.ts:21`, `packages/engine/src/services/chunkEncoder.ts:828` |

## Decision

An **offline comparator, independent of the renderer**, works on outputs written to disk (muxed files, or the lossless PNG sequence for the pre-encode tier):

1. Both sides are decoded with the same pinned FFmpeg, using `-fps_mode passthrough` so FFmpeg cannot hide dropped or duplicated frames. VP8/VP9 is decoded with libvpx so alpha is real.
2. `measure()` produces raw measurements with no thresholds. `judge()` applies the calibrated limits. Calibration and the gate therefore share one measurement path.
3. Verdicts are PASS / FALLBACK / FAIL with stable reason codes:
   - every error, missing tool, missing threshold or empty check set is FAIL or FALLBACK, never PASS;
   - the kill switch `TURBO_FIDELITY=off` records FALLBACK/DISABLED.
4. Hard invariants are exact and never calibrated:
   - geometry, codec, pix_fmt and frame count;
   - declared rational fps and per-frame PTS, in BigInt ticks;
   - PTS/DTS order;
   - audio format;
   - alpha presence;
   - colour transfer, primaries, matrix and range;
   - HDR mastering and content light metadata.
5. Noisy metrics are calibrated per **path** (`<profile>.<platform>`) and per fixture from at least 5 warm reference renders (every pair). The rule is: exact if all pairs agree, otherwise worst ± max(3·MAD, resolution). A/V drift is never tighter than one codec frame. There are no universal cut-offs.
6. Every frame is covered temporally (thumbnail alignment). Full-frame pixel comparison runs on a deterministic, seeded sample: first and last frame, cuts ±1, transition, opacity, rapid-motion and filter-heavy probes, motion-blur neighbours, static holds, and 8 random frames. Full-sequence PSNR/SSIM catches what the sample misses.
7. VMAF is computed only for SDR without alpha and is never the sole gate.
8. Results attach to raw runs as `fidelity` (`turbo-bench-run/2`). `/1` stays readable.

### Alternatives considered

| Option | Outcome |
|---|---|
| Compare inside the render process (hook upstream) | Rejected: requires upstream changes, ties the gate to one backend, cannot see encode or mux. |
| Pixel comparison with an npm image library | Rejected: new dependency, no 10-bit or HDR support. Raw-buffer statistics are about 100 lines of TypeScript. |
| Compare `framemd5` only | Rejected as the sole check: it cannot tolerate legitimate encoder noise and gives no magnitude. Exact comparison is still what happens when the calibrated spread is zero. |
| Universal thresholds (e.g. PSNR ≥ 40 dB) | Rejected: they hide regressions on deterministic paths and reject legitimate noisy ones. Calibration per path makes the tolerance a measured fact. |

## Consequences

- A backend is enabled for a fixture/path only when the gate returns PASS. FALLBACK means: use the Chromium reference.
- Every new backend path needs its own ≥5-run calibration, and an argument for why its tolerance is acceptable. PR01 calibrates only the reference paths.
- The gate costs wall time and FFmpeg CPU per output (see *Measurements*). It runs after rendering and is not part of benchmark wall time.
- `--keep-output` is opt-in. Default PR00 behaviour (delete outputs) is unchanged.

## Fallback and rollback

- **Kill switch:** `TURBO_FIDELITY=off` records FALLBACK/DISABLED. It never records PASS.
- **Missing capability** (libvmaf, thresholds for a path, a decodable stream): FALLBACK or FAIL with a reason. Never silent.
- **Rollback:** revert the PR. All new code is in `benchmarks/src/fidelity/`, `benchmarks/fidelity/`, `benchmarks/test/` and a separate workflow. Disabling `.github/workflows/fidelity.yml` does not affect benchmarks.

## Measurements

Filled in from committed evidence; see below.
