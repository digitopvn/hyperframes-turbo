# Benchmark protocol

The harness under `benchmarks/` extends upstream `packages/producer/src/benchmark.ts`. It uses the same `createRenderJob` + `executeRenderJob` entry point, the same `perfSummary`, and the same fixture layout (`src/index.html` + `meta.json`). Upstream code is not modified. Every additional metric is observed from outside the render.

## Reproduce

Prerequisites: Node 24, Bun, FFmpeg/ffprobe on `PATH`, and `nvidia-smi` (optional, for GPU/VRAM).

```bash
git submodule update --init
cd upstream/hyperframes && bun install --frozen-lockfile && bun run build && cd ../..
node --import ./upstream/hyperframes/node_modules/tsx/dist/loader.mjs benchmarks/src/run-benchmark.ts --warm-runs 5
```

Options:

| Option | Effect |
|---|---|
| `--fixtures a,b` | Run only the listed fixtures |
| `--profiles producer-default,cli-local-default` | Choose the profiles (`benchmarks/src/profiles.ts`) |
| `--out dir` | Write results to `dir` |
| `--strict-idle` | Refuse to run instead of only flagging when the host is busy |

Other commands:

- Regenerate a report from existing raw data: `node --import … benchmarks/src/report.ts benchmarks/results/<dir>`.
- Write only the environment manifest: `node --import … benchmarks/src/collect-environment.ts`.

## Method

- **Cells.** Each fixture × profile pair is one cell, run as a fresh Node child process with a fresh, empty extraction-cache dir (`HYPERFRAMES_EXTRACT_CACHE_DIR`).
- **Run order.** Run 0 is **cold**: new process, new Chrome, empty cache. Runs 1..N are **warm**: same process and the same project dir, so upstream may reuse its browser pool and extraction cache exactly as a user re-export would.
- **Statistics.** Cold runs are never mixed into warm statistics.
- **Profile pairing.** For each fixture, the profiles run back to back, so paired cells share host conditions.
- **Idle gate.** A 10 s idle check runs before the benchmark starts, and a 3 s check runs before every run. The thresholds are CPU < 20 % (above this desktop's measured ~10-14 % noise floor) and GPU util < 15 %. A run on a busy host gets `idle.ok=false`, which is counted in the report as "idle flags". With `--strict-idle` the run is refused and written as `{refused:true}`.
- **Samplers.**
  - `nvidia-smi` every 200 ms: utilisation of gpu/enc/dec and `memory.used`. ΔVRAM is measured against a sample taken right before the run.
  - A process-tree sampler (PowerShell CIM) every 1 s: the summed working set of Node and every descendant, CPU seconds, and I/O transfer bytes.
  - A CDP tap: in-memory patching of puppeteer `Connection._rawSend`/`onMessage`, which counts request/response/event bytes per CDP method and per-call latency.
- **Stage critical path.** Upstream `[Render:trace]` end events give `[elapsed − duration, elapsed]` intervals. `trace-analysis.ts` sweeps them, attributes each wall-time slice to the active stages, and marks as critical the stage that ends last.
- **Hardware and platforms.** One host only. `environment.json → testedPlatforms / notTested` lists which platforms were tested and which were not.

## Fixtures

Fixtures are listed in `benchmarks/fixtures/manifest.json`. Golden fixtures are tagged `turbo-golden`, 1920×1080 at 30 fps. Media comes from FFmpeg `lavfi` recipes (`media-recipes.json`), is generated on first use, and is cached in `benchmarks/.cache/` (gitignored). The file hashes are recorded in every run.

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
  environment.json        turbo-bench-environment/1
  run-manifest.json       turbo-bench-manifest/1   (command, window, profiles, preflight, cell exit codes)
  raw/<fixture>/<profile>/run-<n>.json   turbo-bench-run/1
  runs.csv                one row per run (RunMetrics, benchmarks/src/report.ts)
  summary.csv / summary.json   turbo-bench-summary/1 (per cell: cold, warm Distribution per metric)
  report.md
```

### `turbo-bench-run/1` (raw, source of truth)

| Field | Meaning |
|---|---|
| `fixture`, `category`, `source`, `fixtureSourceSha256`, `inputs.media/vendor` | Provenance: hashes of every input |
| `profile`, `profileEnv` | Profile name and every `PRODUCER_*`/`HF_*`/`HYPERFRAMES_*` env var in effect |
| `resolvedEngineConfig` | Run 0 only: upstream `resolveConfig()` output, i.e. which fast paths were eligible |
| `run`, `kind` (`cold`/`warm`), `startedAt`, `wallMs`, `error`, `jobStatus` | Run identity and outcome. `wallMs` covers `executeRenderJob` from start to end. |
| `idle` | The `{ok, cpuBusyPct, gpuUtilPct, gpuEncPct, attempts, thresholds}` result of the gate before this run |
| `cdpTap` | `inboundBytes`, `outboundBytes`, `eventBytes`, and `byMethod[m] = {calls, bytes, latenciesMs[]}` |
| `gpu`, `gpuTimeline` | GPU summary (avg/peak util, peak VRAM, ΔVRAM) and samples as `[t, gpu%, enc%, dec%, MiB]` |
| `processTree`, `processTreeTimeline` | Peak working set (total and by process name), CPU s, read/write transfer bytes; samples as `[t, bytes, count]` |
| `extractCacheBytesAfter` | Size of the extraction cache dir after the run |
| `output` | ffprobe result: size, duration, bitrate, and per stream codec/pix_fmt/frame rate/packets/color/alpha_mode/audio |
| `traceEvents` | Every upstream `[Render:trace]` event (the full logger stream, not the 160-event capped copy) |
| `perfSummary` | Upstream `RenderPerfSummary`, unmodified |

The derived metrics in `RunMetrics` (`report.ts`) are pure functions of a raw run. PR01 should add fidelity fields to the raw run, for example under a new `fidelity` key, and bump the schema to `/2`. It should not change existing fields.

## Known measurement limits

- The CDP tap counts bytes after puppeteer receives them. Readback inside Chrome (GPU → CPU) is not visible.
- Working set is sampled every 1 s, so short peaks can be missed. Upstream `peakRssMb` covers the Node process only.
- Readback counts `Page.captureScreenshot`, `HeadlessExperimental.beginFrame`, `Runtime.callFunctionOn` and `Runtime.evaluate` response bytes. The last two also carry non-frame traffic, such as drawElement pixels and HDR float16 buffers, as well as small control replies. The per-method split is in `cdpTap.byMethod`.
- "Cost/minute" is not reported as money. The report gives CPU seconds and wall time per output second (render factor), so any instance price can be applied.
