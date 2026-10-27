# Upstream fast-path inventory

Every citation is `path:line` inside `upstream/hyperframes/packages/` at the pinned SHA `1c4a1c162033f22935c0c315efc5245b0cd6ac5d`. "Default" means the value of `DEFAULT_CONFIG` plus `resolveConfig()` with no env and no overrides, which is what the producer API and `packages/producer/src/benchmark.ts` use. The CLI (`hyperframes render`) changes some of these defaults; the "CLI local" column covers that case. The resolved config for each benchmark cell is recorded in `run-0.json → resolvedEngineConfig`, so these claims can be checked against the measured runs.

## Capture path

| Fast path | Producer default | CLI local default | Why / gate | Citation |
|---|---|---|---|---|
| Browser GPU | **software** (SwiftShader) | **auto** (hardware when Chrome can use it) | Software always works but is "~5-50× slower than GPU" (upstream comment) | `engine/src/config.ts:47`, `:295`; `cli/src/browser/gpuPolicy.ts:3-14` |
| Software GPU → screenshot clamp | **on** | lifted for `auto` | `resolveConfig` forces `forceScreenshot=true` when GPU mode is software and the user has not opted out explicitly. Gives defence in depth for BeginFrame stalls and correct `captureMode` reporting. | `engine/src/config.ts:996-1036`; `cli/src/commands/render.ts:1098-1105` |
| `HeadlessExperimental.beginFrame` capture | off on Windows/macOS | off on Windows/macOS | `browserManager` launches BeginFrame only on Linux + chrome-headless-shell + `!forceScreenshot`. It keeps a damage cache. | `engine/src/config.ts:1000`; `engine/src/services/screenshotService.ts:72-186` |
| `Page.captureScreenshot` | the path actually used on this host by `producer-default` | fallback | Image is returned base64 in the CDP response and decoded to a Buffer in Node | `engine/src/services/screenshotService.ts:215-240` |
| drawElement (`useDrawElement`) | flag **true**, but resolves **off** under software GPU (`clampReason:"software_gpu"`) | eligible by config, but measured **off** at 5 workers (`clampReason:"parallel"`) | `resolveDefaultDrawElement`: requires darwin/win32, not software GPU, no Chrome ≤150 ceiling, and worker encode. Upstream claims "~46% faster than Page.captureScreenshot on local GPU" (not verified here). | `engine/src/config.ts:302`, `:751-765`; `engine/src/services/drawElementService.ts:10` |
| drawElement worker encode | true | true | Precondition for drawElement default-on | `engine/src/config.ts:303` |
| Page-side compositing | `DEFAULT_CONFIG` **true**, but `resolveConfig` turns it off while drawElement is on | same | Doc comment says "Default OFF", which contradicts the value (see Discrepancies) | `engine/src/config.ts:132-149`, `:307`, `:1091-1092` |

## Frame reuse and media

| Fast path | Default | Why / gate | Citation |
|---|---|---|---|
| Static-frame dedup | flag **true**; arms only in screenshot mode | Skipped when capture mode ≠ screenshot, when a before-capture hook is set (video injection), or with page-side compositing. Verifies by screenshot within a 15 s budget. `HF_STATIC_DEDUP=false` disables it. | `engine/src/config.ts:70-72`, `:301`, `:841-842`; `engine/src/services/frameCapture.ts:3510-3520`, `:3900-3915` |
| Video frame injection | on whenever `<video>` is present | Pre-extracted frames are pushed into the page as base64 `data:` URIs | `engine/src/services/videoFrameTransport.ts:23`, `:83-99` |
| Extraction cache | on, 2 GiB cap | Content-addressed sha256 key. `HYPERFRAMES_EXTRACT_CACHE_DIR` / `_MAX_MB` override it. | `engine/src/config.ts:276`, `:333`; `engine/src/services/extractionCache.ts:121`, `:168` |
| drawElement PSNR self-verify | on with drawElement | Compares drawElement against a reference and falls back below `verifyMinDb` | `engine/src/services/parallelCoordinator.ts:728-732` |

## Encode

| Fast path | Default | Why / gate | Citation |
|---|---|---|---|
| Streaming encode (pipe frames to FFmpeg during capture) | flag **true** | Auto-disabled on the Windows software-GPU single-worker compound. Our 5-worker runs reported `useStreamingEncode:false` with `capturePath:"disk"`, so frames went to disk and the encode ran afterwards. The exact upstream decision is visible in `perfSummary.observability.capture` but was not traced further in PR00. | `engine/src/config.ts:159`, `:312`, `:594-640`, `:1058-1076` |
| Chunked encode | **false** | Opt-in | `engine/src/config.ts:157`, `:310` |
| GPU encoders (nvenc/videotoolbox/vaapi/qsv/amf) | **off** (`useGpu=false`) | Opt-in. The benchmark keeps `useGpu:false`, like the upstream regression harness. | `engine/src/services/streamingEncoder.ts:233`, `:283-331`; `producer/src/services/renderOrchestrator.ts:404` |

## HDR

| Path | Default | Note | Citation |
|---|---|---|---|
| WebGPU float16 HDR capture | used for HDR content | Node converts HLG/PQ → linear → float16, then base64 readback. Upstream documents "~6 fps at 1080x1920". | `engine/src/services/hdrCapture.ts:5-19` |

## Discrepancies found

1. `enablePageSideCompositing`: the JSDoc says "When this flag is OFF (the default)" / "Default OFF" (`engine/src/config.ts:132-144`), but `DEFAULT_CONFIG` sets `true` (`:307`). The effective behaviour stays off while drawElement is on (`:1091`). On hosts where drawElement resolves off — including every software-GPU render — the resolved value is `true`, contrary to the docs. Before filing anything upstream, check the `resolvedEngineConfig` recorded in the runs.

## Not covered by PR00

- Linux BeginFrame, macOS Metal, and Docker/Lambda/Cloud Run paths: not tested on this host.
- The upstream "~46% faster" and "~6 fps" claims above are quoted, not reproduced. PR00 measures only the paths each profile actually selects on this host.
