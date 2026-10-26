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

Other commands, run from `benchmarks/` (`benchmarks/package.json` has the same commands as scripts):

- Regenerate the report from raw data: `node --import … src/report.ts results/<dir>`
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
  raw/<fixture>/<variant>/run-<n>.json   turbo-bench-run/1
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

Every derived metric in `RunMetrics` (`report.ts`) is a pure function of one raw run. PR01 should add fidelity data under a new `fidelity` key in the raw run and bump that schema to `/2`, rather than change the existing fields.

## Known measurement limits

- The CDP tap counts bytes as puppeteer sees them. Readback inside Chrome (GPU → CPU) is not visible.
- Pixels that never cross CDP are visible only as process-tree disk I/O and `tmpPeakBytes`. The main example is the HDR layered path, where FFmpeg pre-extracts native HDR frames and Node composites them (`producer/src/services/renderOrchestrator.ts:4551-4555`).
- Working set is sampled every 1 s, so short peaks can be missed. Upstream `peakRssMb` covers the Node process only.
- `frameRpcResponseBytes` counts responses of `Page.captureScreenshot`, `HeadlessExperimental.beginFrame` and `Runtime.callFunctionOn`. The last of these also carries small non-frame replies; the per-method split is in `cdpTap.byMethod`.
- The inferred `encode` interval assumes upstream finalises encoding when the capture stage ends. Its start is derived from the reported duration, not observed.
