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

All numbers come from committed artefacts. Platforms not listed are not tested.

**Windows 11, RTX 5060 Ti, FFmpeg 8.0 (gyan.dev essentials), upstream `1c4a1c1`**
(`benchmarks/results/2026-10-27-1c4a1c1-fidelity/`, 13 fixtures × 1 cold + 5 warm):

- Nine fixtures were bit-exact across all warm pairs. Four were not:

  | fixture | non-exact pairs | max abs diff | max diff-pixel % | min encoded PSNR |
  |---|---|---|---|---|
  | fps-ntsc-30000-1001 | 6/10 | 67 | 1.64 | 62.30 dB |
  | gsap-static-holds | 4/10 | 21 | 2.67 | 55.29 dB |
  | motion-blur | 9/10 | 52 | 4.14 | 60.64 dB |
  | typography-svg | 4/10 | 63 | 1.62 | 62.18 dB |

  Per-fixture limits for these four are in `benchmarks/fidelity/thresholds/producer-default.win32.json`.
- The gate gave PASS on all 13 fixtures (run 2 vs run 1). It took 0.5 to 6.9 s per fixture and about 51 s in total. The peak comparator RSS was 284 MiB, excluding FFmpeg children.
- VMAF between identical 1080p encodes is about 97.43, not 100. VMAF is therefore never the sole check.
- Fault injection caught 111 of 111 faults across 16 kinds, with 0 missed. All 13 untouched controls gave PASS (`benchmarks/fidelity/negative-results/producer-default.win32.md`).
  - The two single-property HDR faults fail with `HDR_METADATA_MISMATCH` and no other reason on both HDR fixtures. They are `hdr-sei-stripped` (byte-neutral retype of every prefix SEI, in-band and in `hvcC`, VUI kept) and `hdr-max-cll-changed` (MaxCLL only).
- Negative result: the earlier HDR metadata check was blind.
  - ffprobe `-show_entries frame=side_data_list` prints every entry empty, so mastering and content-light metadata compared `null` with `null`.
  - The old `hdr-metadata-stripped` fault was caught only through `HDR_TRANSFER_MISMATCH`.
  - The check now reads `frame_side_data` for every frame and compares stream-level and per-frame carriers separately.
- `--keep-output` overhead: **not measured**. A 5+5 run comparison was made, but its raw runs were not kept, so no numbers are claimed. By construction, the copy and hash run after the worker stops its wall clock (`render-worker.ts`), so recorded render times exclude them. Their own cost is unmeasured.
- The first attempt is kept as a negative result: `producer-default.win32.attempt-1-injector-colour-defect.md`.

**ubuntu-24.04 GitHub runner, SwiftShader, FFmpeg 6.0.1 static** (correctness only, no performance claims):

- Four fixtures were bit-exact (`producer-default.linux.json`).
- The gate gave PASS on all four, and fault injection caught 13 kinds with 0 missed (CI workflow `fidelity.yml`).

## Known limits

These are tracked in a follow-up issue and are not solved by this ADR:


- Container-level HDR metadata (MP4 `mdcv`/`clli`) is compared but was absent from every output here. Only the per-frame SEI branch has been exercised by a real fault; the container branch is covered by a unit test only.

## Addendum: gate hardening (issue #5)

- **Candidate tolerances.** Decision: a candidate backend's limits come from a cross-reference calibration between two accepted reference configurations (`calibrate.ts --against-cell`), never from the candidate's own runs and never from hand-loosening. Only cells on the committed list `benchmarks/fidelity/reference-cells.json` (today `producer-default`, the Chromium reference) may calibrate or act as the reference of a gate run; both CLI modes require the cell names and FAIL with `THRESHOLD_INVALID` otherwise, so a backend cannot pass against itself or against limits from its own renders. The threshold schema records `calibration.kind` (`repeat` or `cross-reference`) and the second cell's runs, and validation rejects a self-referencing or under-sampled file. No cross-reference file exists yet because there is only one accepted reference configuration. See `docs/fidelity-protocol.md`, *Candidate tolerances*.
- **Near-threshold faults.** A/V offsets of 22, 25 and 30 ms, a +/-2 code-value luma block on a sampled and an unsampled frame, and the least distinct observable stale frame. A row is required when it is an A/V offset larger than the calibrated A/V limit plus the 0.125 ms lag resolution, or a pixel or temporal fault on a bit-exact fixture (every limit there is exact); the magnitude of a pixel or temporal fault is not compared with the limit, and on a non-deterministic fixture its outcome is informational. Results are in `benchmarks/fidelity/negative-results/`.
- **HDR and alpha frame faults.** Frame-rewrite faults now re-encode losslessly in HEVC 10-bit (HDR SEI re-emitted) and VP9 alpha, as well as H.264.
- **CLI and CI.** `cli.test.ts` asserts exit codes 0/1/3/2. CI gates warm run 2 against warm run 1 of the same job: a determinism check, not a golden reference. A frozen golden reference for cross-version comparison is still not kept. An intentionally red step (audio stripped) must exit 1. FFmpeg and Chrome headless shell binaries are sha256-verified on every run and actions are pinned by commit SHA.
- **Measured (Windows, producer-default.win32).** 193 rows, 22 fault kinds caught, 0 errors, 7 near-threshold rows informational, and 1 miss: the unmodified motion-blur control failed on a max|diff| of 54 against a calibrated limit of 53, a false positive from a 5-run calibration that did not see the full reference spread. It is published, not loosened (`benchmarks/fidelity/negative-results/README.md`).
