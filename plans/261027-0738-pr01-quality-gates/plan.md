---
title: "PR01 - Cổng chất lượng fidelity (frame/audio/HDR/alpha) + CI + schema kết quả"
description: "Bộ so sánh fail-closed PASS/FALLBACK/FAIL giữa output ứng viên và tham chiếu Chromium, ngưỡng hiệu chỉnh theo path, CI SwiftShader."
status: pending
priority: P1
effort: 34h
branch: claude/hyperframes-turbo-issue-1-2b3d24
tags: [pr01, fidelity, quality-gate, ci, schema]
created: 2026-10-27
---

# PR01 - Cổng chất lượng fidelity

Nền: PR00 (`origin/claude/pr00-baseline-c2c478`, PR #2, chưa merge). PR01 phải rebase lên PR00 sau khi merge; nếu PR00 đổi, chạy lại bước "Xác minh lại" bên dưới.

## 1. Kết quả mong muốn (định nghĩa "xong")

1. `benchmarks/src/fidelity/run-fidelity.ts` nhận một cặp (reference, candidate) output đã render cho cùng fixture/settings, giải mã thành pixel thô, và ghi `fidelity` vào `turbo-bench-run/2` với verdict `PASS | FALLBACK | FAIL` cho từng check và tổng.
2. Mọi lỗi nội bộ (ffprobe lỗi, thiếu ngưỡng, thiếu tool như libvmaf, sample rỗng) cho ra `FAIL` hoặc `FALLBACK`, không bao giờ `PASS`.
3. Ngưỡng nằm trong `benchmarks/fidelity/thresholds/<path>.json`, sinh ra từ >=5 lần render tham chiếu lặp lại (không gõ tay), kèm nguồn gốc (host, SHA, số mẫu).
4. GitHub Actions `fidelity.yml` chạy trên `ubuntu-latest` với SwiftShader, chỉ kiểm tính đúng (không có số đo tốc độ), upload báo cáo làm artifact, và fail job khi có `FAIL`.
5. Bộ test âm tính (lỗi tiêm có chủ đích) chứng minh mỗi check bắt được lỗi của nó; kết quả âm tính được commit vào `benchmarks/fidelity/negative-results/`.

Không thuộc phạm vi: bất kỳ backend tăng tốc nào; benchmark tốc độ trên CI; thay đổi code upstream.

## 2. Bằng chứng đã xác minh (đọc từ nhánh PR00)

| Sự kiện | Trích dẫn |
|---|---|
| Schema run hiện tại `turbo-bench-run/1`, các key top-level: `fixture, profile, run, kind, wallMs, error, output{sizeBytes,durationSec,bitRate,formatName,streams}, perfSummary, ...` | `benchmarks/results/2026-10-26-1c4a1c1/raw/*/run-0.json` |
| Output video bị xoá sau mỗi run | `benchmarks/src/render-worker.ts:257` (`rmSync(outputPath)`) |
| Đường dẫn output | `benchmarks/src/render-worker.ts:159` |
| ffprobe đã dùng `-count_packets -show_format -show_streams` | `benchmarks/src/render-worker.ts:72-84` |
| Profiles `producer-default` (SwiftShader, screenshot) và `cli-local-default` (GPU auto) | `benchmarks/src/profiles.ts:12-30` |
| Manifest fixture (7 local + 3 upstream: `webm-transparency`, `hdr-hlg-regression`, `hdr-regression`) | `benchmarks/fixtures/manifest.json` |
| Media sinh từ lavfi, gồm `h264-vfr.mp4` | `benchmarks/fixtures/media-recipes.json` |
| Manifest nói media được sinh bởi `benchmarks/src/media.ts`, nhưng file này **không có** trong tree PR00 | `git ls-tree` nhánh PR00 [UNVERIFIED: có thể logic nằm trong `fixtures.ts`] |
| Tất cả fixture local cấu hình 30 fps, 1920x1080 | `benchmarks/fixtures/*/meta.json` |
| Upstream có PSNR self-verification trong `frameCapture.ts` | issue #1 [UNVERIFIED: submodule không checkout trên máy này; phải đọc trước khi viết Phase 2 để tái dùng, không sao chép] |

Ràng buộc khi lập plan: không chạy build/test/render/ffmpeg trên máy này (đang chạy benchmark GPU). Mọi con số ngưỡng trong plan là **phương pháp**, không phải giá trị.

## 3. Quyết định kiến trúc (sẽ thành `docs/adr/0002-fidelity-gates.md`)

**Quyết định:** Bộ so sánh offline, độc lập với renderer, chạy trên **file output đã mux** và trên **frame pixel thô giải mã bằng FFmpeg ghim phiên bản**, viết bằng TypeScript trong `benchmarks/src/fidelity/`, gọi `ffmpeg`/`ffprobe` qua `child_process` (giống `render-worker.ts`). Không thêm dependency npm mới.

Lý do và phương án đã cân nhắc:

| Phương án | Kết luận |
|---|---|
| A. So sánh trong tiến trình render (hook vào upstream) | Loại: phải sửa upstream, ràng buộc vào một backend, không kiểm được encode/mux. |
| B. So sánh file output bằng filter FFmpeg (`psnr`, `ssim`, `libvmaf`, `framemd5`) + phân tích TS | **Chọn.** Dùng được cho mọi backend tương lai, kiểm cả pre-encode lẫn encode, tái lập được. |
| C. Thư viện ảnh JS (pixelmatch/sharp) | Loại làm đường chính: thêm dependency, không đọc 10-bit/HDR. Pixel diff tự viết trên buffer `rgb48le`/`gbrapf32le`. |

**Tách hai tầng fidelity (yêu cầu issue):**
- `preEncode`: so sánh frame thô mà backend tạo ra trước encoder. Với chromium-reference, ta có được qua chế độ lossless của chính upstream [UNVERIFIED: cần xác nhận upstream có format PNG-sequence/lossless; nếu không, preEncode = encode cả hai với cùng encoder lossless `-c:v ffv1` từ cùng nguồn frame]. PR01 định nghĩa interface; khi chỉ có file mux, `preEncode` = `"unavailable"` và verdict tối đa là `FALLBACK` cho các check yêu cầu nó.
- `encoded`: so sánh output cuối (VMAF khi áp dụng, SSIM/PSNR, bitrate/size).

**Pixel decode:** giải mã cả hai file bằng cùng `ffmpeg` sang `rgb48le` (SDR) hoặc `gbrpf32le` tuyến tính (HDR, sau khi kiểm metadata), với `-vsync passthrough` / `-fps_mode passthrough` để **không** cho ffmpeg tự nhân/bỏ frame (điều đó che lỗi dropped/duplicated). Alpha: `rgba64le` / `yuva444p10le`.

**Chọn frame mẫu:** xác định trước, có seed. Seed = SHA-256(fixture source + settings) để mọi lần chạy và mọi backend mẫu cùng một tập frame.

## 4. Luồng dữ liệu

```text
fixture (PR00 manifest) + profile
  -> render reference (chromium-reference = producer-default) xN   [run-benchmark --keep-output]
  -> render candidate                                               [cùng settings]
  -> probe.ts       : ffprobe -show_frames -show_packets  -> timeline (PTS/DTS/duration, pix_fmt, color_*, side data, audio)
  -> sample-plan.ts : fixture meta + timeline -> danh sách frame index cần so (có lý do: first/last/random/cut/transition/motion/filter/blur-nbhd)
  -> decode.ts      : ffmpeg select theo index -> buffer pixel thô (stream, bounded)
  -> metrics/*.ts   : pixel diff, PSNR, SSIM (ffmpeg filter trên cặp đã trích), temporal (frame hash), A/V, alpha, HDR, VMAF
  -> verdict.ts     : so với thresholds/<path>.json -> PASS/FALLBACK/FAIL + lý do
  -> schema.ts      : ghi run.fidelity (turbo-bench-run/2) + fidelity-report.md/.json
```

Bộ nhớ: decode từng frame một (pipe stdout, đọc đúng `w*h*bpp` byte), không giữ toàn bộ video. Peak RAM dự kiến ~2 frame 4K `rgba64le` (~130 MB). Ghi lại peak RSS trong report (yêu cầu AGENTS.md về tài nguyên).

## 5. Schema: `turbo-bench-run/2`

Tăng phiên bản vì thêm key bắt buộc với run có fidelity. `report.ts` của PR00 phải đọc được cả `/1` (không có `fidelity`) và `/2`. Run `/1` cũ không bị viết lại.

```jsonc
"fidelity": {
  "schema": "turbo-fidelity/1",
  "verdict": "PASS" | "FALLBACK" | "FAIL",
  "reasons": ["string"],                     // mọi check không PASS, có mã ổn định
  "reference": { "profile": "producer-default", "outputSha256": "...", "runs": 5 },
  "candidate": { "profile": "...", "backend": "chromium-reference", "outputSha256": "..." },
  "thresholds": { "path": "producer-default.swiftshader", "file": "...json", "sha256": "...", "calibration": { "runs": 5, "host": "...", "upstreamSha": "..." } },
  "tools": { "ffmpeg": "version + build conf hash", "libvmaf": "version|null" },
  "sampling": { "seed": "hex", "frames": [{ "index": 0, "ptsRational": "0/1", "reasons": ["first"] }] },
  "checks": {
    "frameCount":   { "verdict", "expected", "reference", "candidate" },
    "timestamps":   { "verdict", "fps": "30000/1001", "maxPtsErrorTicks", "nonMonotonicPts", "dtsGtPts", "dropped": [], "duplicated": [], "reordered": [] },
    "pixels":       { "verdict", "perFrame": [{ "index", "psnrDb", "ssim", "maxAbsDiff", "diffPixelPct", "reasons" }], "minPsnrDb", "minSsim" },
    "temporal":     { "verdict", "staleFrames": [], "flickerScore" },
    "audio":        { "verdict", "sampleRate", "channels", "durationDeltaMs", "avDriftMs": { "start", "end", "max" }, "onsetDeltaMs": [], "rmsDeltaDb" },
    "alpha":        { "verdict" | "NOT_APPLICABLE", "pixFmt", "hasAlphaPlane", "alphaPsnrDb", "premultMismatchPct" },
    "hdr":          { "verdict" | "NOT_APPLICABLE", "transfer", "primaries", "matrix", "range", "bitDepth", "masteringDisplay", "contentLight", "linearPsnrDb" },
    "encoded":      { "verdict", "vmaf": { "mean", "p5", "model" } | null, "psnrDb", "ssim", "bitRate", "sizeBytes", "bitRateDeltaPct" },
    "dimensions":   { "verdict", "width", "height", "sar", "codec", "profile", "level" }
  },
  "peakRssBytes": 0,
  "wallMs": 0
}
```

Mã lý do ổn định (dùng trong `reasons`): `FRAME_COUNT_MISMATCH`, `PTS_DRIFT`, `PTS_NON_MONOTONIC`, `FRAME_DROPPED`, `FRAME_DUPLICATED`, `FRAME_REORDERED`, `STALE_FRAME`, `PIXEL_BELOW_THRESHOLD`, `AV_DRIFT`, `AUDIO_MISSING`, `ALPHA_MISSING`, `ALPHA_MISMATCH`, `HDR_METADATA_MISMATCH`, `HDR_TRANSFER_MISMATCH`, `DIMENSION_CHANGED`, `FPS_CHANGED`, `BITRATE_DROP`, `THRESHOLD_MISSING`, `TOOL_UNAVAILABLE`, `CHECK_ERROR`, `PRE_ENCODE_UNAVAILABLE`.

## 6. Ngữ nghĩa fail-closed

| Tình huống | Verdict check | Ghi chú |
|---|---|---|
| Đo được, trong ngưỡng | PASS | |
| Đo được, vượt ngưỡng | FAIL | |
| Bất biến cứng bị vi phạm (độ phân giải, fps, số frame, thiếu audio/alpha, đổi transfer/primaries) | FAIL | Không có ngưỡng nào nới được; đây là "silent downgrade" theo AGENTS.md. |
| Check không chạy được vì thiếu năng lực tuỳ chọn (libvmaf vắng, preEncode không có) | FALLBACK + `TOOL_UNAVAILABLE`/`PRE_ENCODE_UNAVAILABLE` | Không bao giờ PASS. |
| Không có file ngưỡng cho path | FAIL + `THRESHOLD_MISSING` | Không dùng ngưỡng mặc định. |
| Exception / parse lỗi / sample rỗng | FAIL + `CHECK_ERROR` | `try/catch` ở biên mỗi check, không nuốt lỗi. |
| Check không áp dụng (alpha với mp4 SDR) | NOT_APPLICABLE | Chỉ khi fixture meta **khai báo** không áp dụng; suy luận từ output là không đủ (nếu output mất alpha thì phải là FAIL). |

Tổng hợp: `FAIL` nếu có bất kỳ FAIL; ngược lại `FALLBACK` nếu có FALLBACK; ngược lại `PASS`. Ý nghĩa vận hành cho các PR sau: `FALLBACK` = backend ứng viên không được bật ở `--turbo=auto` cho fixture/path đó (dùng chromium-reference). Exit code CLI: 0 PASS, 3 FALLBACK, 1 FAIL, 2 lỗi dùng sai.

## 7. Hiệu chỉnh ngưỡng (calibration)

Nguyên tắc: không có cutoff phổ quát. Ngưỡng = hàm của nhiễu đo được giữa các lần render **tham chiếu với chính nó**, theo từng `path` = `profile` + `gpuMode` + `encoder` + `pixFmt` + `os` (ví dụ `producer-default.swiftshader.libx264.yuv420p.linux`).

Thủ tục (`calibrate.ts`):
1. Render tham chiếu N>=5 lần (cold riêng, warm riêng; cold không trộn vào thống kê, theo protocol PR00).
2. So sánh mọi cặp (N*(N-1)/2) trên tập frame mẫu cố định.
3. Với mỗi metric/lớp frame (first/last/random/cut/transition/motion/filter/blur): ghi `min`, `median`, `max` của PSNR/SSIM/maxAbsDiff.
4. Nếu tham chiếu tất định bit-exact (maxAbsDiff=0 ở mọi cặp) thì ngưỡng là **exact** (diff=0, PSNR=inf). Đây là kết quả kỳ vọng cho SwiftShader nhưng phải đo, không giả định.
5. Nếu không tất định: ngưỡng = `worst_observed - margin`, với `margin` = max(3*MAD, độ phân giải đo của metric). Ghi rõ công thức và số mẫu trong file; số mẫu < 5 thì file không hợp lệ (loader trả `THRESHOLD_MISSING`).
6. Ngưỡng cho candidate khác encoder/GPU (không kỳ vọng bit-exact) là **chưa có** trong PR01; các PR tương ứng (PR02+) phải tự calibrate với lập luận riêng. PR01 chỉ đưa ra cơ chế và file cho path tham chiếu.
7. Bất biến cứng (số frame, PTS theo rational fps, kích thước, sample rate, kênh, transfer/primaries) không calibrate; luôn exact.
8. A/V drift: ngưỡng = max(drift quan sát ở tham chiếu, 1 khoảng audio frame AAC = 1024/48000 s ≈ 21.3 ms) - ghi trong file cùng nguồn gốc. [Cần xác nhận codec audio upstream; nếu PCM/Opus thay khoảng frame tương ứng.]

Định dạng file ngưỡng có `"schema": "turbo-fidelity-thresholds/1"`, `path`, `calibration{runs, host, upstreamSha, ffmpeg, createdAt, rawPairsFile}`, `metrics{...}`. Cặp thô được lưu cạnh file (giữ bằng chứng, kể cả khi chúng bất lợi).

CI và local là hai path khác nhau: CI dùng file `*.linux.swiftshader` được calibrate **trên chính runner CI** (workflow `workflow_dispatch` mode `calibrate` upload artifact; maintainer commit file đó). Không dùng ngưỡng Windows cho Linux.

## 8. Ca tham chiếu bắt buộc theo fixture

Chỉ số frame tính theo fps của fixture (30 fps trừ khi ghi khác). Mốc thời gian lấy từ `data-start`/`data-duration` trong `src/index.html`; phase 1 phải trích tự động (`sample-plan.ts` đọc DOM tĩnh) và đối chiếu bảng dưới, không gõ tay index. Mọi fixture còn có: frame 0, frame cuối, 8 frame ngẫu nhiên có seed, kiểm số frame/PTS, kiểm kích thước/fps.

| Fixture | Ca bắt buộc |
|---|---|
| `typography-svg` (8 s) | Frame có text nhỏ nhất (độ sắc cạnh: thêm metric gradient-energy so với ref); frame giữa animation stroke SVG; frame chuyển động nhanh nhất (lấy từ tween có tốc độ lớn nhất). |
| `gsap-static-holds` (10 s) | Frame đầu và cuối mỗi đoạn hold, và frame ngay sau khi hold kết thúc (bắt **stale frame** do dedup); kiểm temporal: frame trong hold phải giống nhau, frame sau hold phải khác. |
| `css-filters-blend` (6 s) | Frame filter-heavy (backdrop-filter x2, blend multiply/screen/difference) tại đỉnh blur; ranh giới opacity 0 và 1; frame mà phần tử blend đi qua nền thay đổi. |
| `canvas-webgl` (6 s) | Frame 0 (bắt stale-first-frame của WebGL), frame shader toàn màn hình, 3 frame liên tiếp (bắt duplicated/stale canvas). |
| `video-heavy` (8 s) | Mỗi cut `bg-a`->`bg-b` (frame trước/tại/sau cut); clip `pip1` HEVC 60 fps vào 30 fps output (kiểm chọn frame nguồn đúng); clip `pip2` **VFR**: frame ở vùng mật độ cao (n<60) và vùng thưa (mod 3), kiểm ánh xạ timestamp nguồn -> frame output; start offsets 1 s và 4 s. Nội dung `testsrc2` có bộ đếm khung nên có thể kiểm frame nguồn đúng bằng so pixel vùng đếm. |
| `audio-mix` (8 s) | Onset 3 SFX tại 1.0/3.5/6.0 s (cross-correlation, đo onsetDelta); fade-in 0-1 s và fade-out 6.5-8 s (RMS envelope); tổng thời lượng audio = video; kênh stereo 48 kHz. |
| `mixed-complex` (10 s) | Cut tại 6 s (frame 179/180/181), transition boundary, backdrop-filter + overlay blend, video nền h264 + SFX hit tại 6 s (A/V: onset audio so với frame cut, cùng thời điểm). |
| `webm-transparency` (upstream) | Kênh alpha tồn tại (`yuva420p`/`alpha_mode=1`), so alpha plane riêng (PSNR alpha), cạnh bán trong suốt (premultiplied vs straight), frame 0/cuối. |
| `hdr-regression` (PQ, upstream) | `color_transfer=smpte2084`, `color_primaries=bt2020`, `colorspace=bt2020nc`, 10-bit, side data mastering display + content light (nếu ref có); PSNR trên giá trị tuyến tính; không dùng VMAF SDR. |
| `hdr-hlg-regression` (upstream) | `color_transfer=arib-std-b67`, bt2020, 10-bit; so pixel tuyến tính; không đòi mastering metadata nếu ref không có (đối chiếu đúng như ref). |

**Ca thiếu trong fixture PR00 phải bổ sung** (thêm fixture mới, không sửa fixture PR00 để không làm hỏng baseline):
- `fps-ntsc-30000-1001`: biến thể của `typography-svg` với `renderConfig.fps` = 30000/1001 [UNVERIFIED: upstream chấp nhận fps rational dạng nào; đọc `config.ts`/meta schema trước]. Kiểm PTS tích luỹ không trôi tại frame cuối (sai số <= 1 tick timebase).
- `motion-blur`: fixture có motion blur [UNVERIFIED: cơ chế motion blur của upstream; tìm trong submodule]. Ca: vùng lân cận thời gian (frame t-1, t, t+1) quanh tween nhanh nhất.
- `transition-crossfade`: hai scene với transition opacity, ca: frame đầu, giữa, cuối transition.
Nếu upstream không hỗ trợ motion blur hay fps rational, ghi vào `negative-results/` và báo cáo, không giả lập.

## 9. Danh sách file (sở hữu theo phase)

Mới:
- `benchmarks/src/fidelity/probe.ts` (P1)
- `benchmarks/src/fidelity/rational.ts` (P1) - số hữu tỉ BigInt, ánh xạ index<->PTS
- `benchmarks/src/fidelity/sample-plan.ts` (P1)
- `benchmarks/src/fidelity/decode.ts` (P2)
- `benchmarks/src/fidelity/metrics/pixels.ts`, `temporal.ts` (P2)
- `benchmarks/src/fidelity/metrics/audio.ts` (P3)
- `benchmarks/src/fidelity/metrics/alpha.ts`, `hdr.ts` (P3)
- `benchmarks/src/fidelity/metrics/encoded.ts` (P3)
- `benchmarks/src/fidelity/verdict.ts`, `schema.ts`, `thresholds.ts` (P4)
- `benchmarks/src/fidelity/run-fidelity.ts`, `calibrate.ts`, `report.ts` (P4)
- `benchmarks/src/fidelity/inject-faults.ts` (P5) - tạo candidate lỗi từ ref bằng ffmpeg (drop/dup/reorder frame, dịch audio 40 ms, bỏ alpha, đổi transfer, giảm bitrate, hạ 1 px độ phân giải, làm mờ 1 frame)
- `benchmarks/test/fidelity/*.test.ts` (P5) - dùng `node:test`, không dependency mới
- `benchmarks/fidelity/thresholds/*.json`, `benchmarks/fidelity/negative-results/*.md` (P6)
- `benchmarks/fixtures/{fps-ntsc-30000-1001,motion-blur,transition-crossfade}/` (P1)
- `.github/workflows/fidelity.yml` (P6)
- `docs/adr/0002-fidelity-gates.md`, `docs/fidelity-protocol.md` (P6)

Sửa (từ PR00):
- `benchmarks/src/render-worker.ts`: thêm `--keep-output <dir>`; khi có cờ, chuyển output vào thư mục kết quả thay cho `rmSync` ở dòng 257. Mặc định giữ hành vi PR00 (không đổi số đo baseline). Ghi `outputSha256`.
- `benchmarks/src/run-benchmark.ts`: truyền `--keep-output`, thêm `--fidelity-against <profile>` chạy fidelity sau khi cell xong; schema run `/2` chỉ khi có fidelity.
- `benchmarks/src/report.ts`: đọc `/1` và `/2`, thêm bảng Fidelity.
- `benchmarks/fixtures/manifest.json`: thêm 3 fixture mới.
- `benchmarks/package.json`: script `fidelity`, `calibrate`, `test`.
- `docs/benchmark-protocol.md`: mục "Fidelity" ngắn, link tới `docs/fidelity-protocol.md`.

## 10. Phase và phụ thuộc

| Phase | Nội dung | Phụ thuộc | Ước lượng |
|---|---|---|---|
| P0 | Xác minh lại sau khi PR00 merge: đọc upstream `frameCapture.ts` (PSNR), meta schema fps, motion blur, định dạng lossless; cập nhật các mục [UNVERIFIED] | PR00 merge | 2h |
| P1 | probe, rational, sample-plan, 3 fixture mới, `--keep-output` | P0 | 6h |
| P2 | decode bounded + pixels/temporal | P1 | 6h |
| P3 | audio, alpha, hdr, encoded (VMAF tuỳ chọn) | P1 (song song với P2, file riêng) | 7h |
| P4 | verdict, thresholds loader, schema `/2`, run-fidelity, calibrate, report | P2, P3 | 5h |
| P5 | fault injection + unit/integration test | P4 | 5h |
| P6 | calibrate trên CI và local, workflow, ADR, docs, negative results | P5 | 3h |

P2 và P3 không chạm cùng file. `schema.ts`/`verdict.ts` chỉ thuộc P4.

## 11. Workflow CI (`.github/workflows/fidelity.yml`)

- Trigger: `pull_request` (paths `benchmarks/**`, `upstream`, workflow), `workflow_dispatch` với input `mode: check|calibrate`.
- `runs-on: ubuntu-24.04` (ghim, không `latest`, để ngưỡng gắn đúng image). `timeout-minutes: 45`. `concurrency` hủy run cũ cùng ref. `permissions: contents: read`.
- Bước: checkout với `submodules: recursive` -> setup Node 24 + Bun (ghim phiên bản như protocol PR00) -> cài FFmpeg ghim (static build có checksum SHA-256 kiểm tra trước khi dùng; cần `libvmaf`, nếu build không có thì check VMAF trả FALLBACK, không fail) -> cache `upstream/hyperframes/node_modules` theo hash lockfile -> `bun install --frozen-lockfile && bun run build` trong upstream -> Chrome headless shell do upstream/puppeteer ghim -> render tham chiếu (`producer-default`, SwiftShader, `--no-control`, `--warm-runs 1` cho mode check; `--warm-runs 5` cho calibrate) với `--keep-output` -> `fidelity` so ref vs ref-lặp lại (chứng minh tất định) và vs mọi candidate có sẵn -> chạy test fault-injection -> upload `fidelity-report.{json,md}` + thresholds/pairs (mode calibrate) làm artifact, `retention-days: 30`.
- Fail job khi verdict tổng là FAIL, hoặc test fault-injection không bắt được lỗi. FALLBACK không fail job nhưng hiện trong job summary.
- Ghi rõ trong job summary: "Correctness only. SwiftShader timings are not benchmarks." Không xuất số tốc độ.
- Bảo mật: không secret; HTML fixture coi là không tin cậy, Chrome chạy trong container runner không có token ghi (`permissions: contents: read`).

## 12. Ma trận test

| Mức | Nội dung |
|---|---|
| Unit | `rational.ts` (30000/1001 qua 10.000 frame không trôi, so với BigInt), parse ffprobe từ JSON mẫu đã commit, verdict aggregation (mọi tổ hợp), threshold loader từ chối file < 5 mẫu/không có path, sample-plan tất định theo seed, đọc mốc thời gian từ HTML. |
| Integration (cần ffmpeg, chạy trên CI) | Fault injection: mỗi lỗi trong `inject-faults.ts` phải sinh đúng mã lý do và FAIL; ref vs chính nó = PASS; thiếu libvmaf giả lập (env `FIDELITY_DISABLE_VMAF=1`) = FALLBACK; xoá file ngưỡng = FAIL `THRESHOLD_MISSING`. |
| End-to-end | Render thật mọi fixture ở `producer-default` trên CI; ref-run-1 vs ref-run-2 PASS. Local (Windows, sau khi benchmark GPU xong): `cli-local-default` vs `producer-default` để ghi nhận kết quả thật (kể cả FAIL) vào negative-results. Đây là dữ liệu cho PR02, không phải cổng của PR01. |

Lệnh xác minh (cho người thực hiện, không chạy lúc lập plan): `bun run typecheck`, `node --test benchmarks/test/fidelity`, `npm run fidelity -- --ref <dir> --cand <dir>`.

## 13. Rủi ro

| Rủi ro | Khả năng x Ảnh hưởng | Giảm thiểu |
|---|---|---|
| SwiftShader không tất định giữa các run -> ngưỡng lỏng che lỗi | Trung bình x Cao | Đo trước; nếu không exact, ghi số liệu và công bố; fault injection chứng minh ngưỡng vẫn bắt được lỗi đã biết. |
| ffmpeg tự nhân/bỏ frame khi decode, che lỗi temporal | Cao x Cao | `-fps_mode passthrough`, đếm frame bằng `-show_frames`, test dup/drop bằng injection. |
| Upstream không hỗ trợ fps 30000/1001 / motion blur | Trung bình x Trung bình | P0 xác minh; nếu không, ghi negative result, không giả lập. |
| Thời gian CI quá dài (render 10 fixture + build upstream) | Trung bình x Trung bình | Cache node_modules; mode check chỉ 1 warm run; timeout 45'. |
| FFmpeg trên runner khác FFmpeg local | Cao x Trung bình | Ghim static build có checksum; `tools.ffmpeg` ghi vào mỗi kết quả; path ngưỡng tách theo OS. |
| Đổi `render-worker.ts` làm sai baseline PR00 | Thấp x Cao | `--keep-output` opt-in; khi tắt, code path giống hệt; overhead.csv so lại. |
| Bộ nhớ khi decode 4K / HDR float | Thấp x Trung bình | Decode từng frame qua pipe, giới hạn 2 buffer, ghi `peakRssBytes`. |

## 14. Tương thích ngược và rollback

- Schema: `/1` vẫn hợp lệ, report đọc cả hai. Không viết lại kết quả PR00.
- Hành vi render mặc định không đổi (cờ opt-in).
- Kill switch: env `TURBO_FIDELITY=off` bỏ qua bước fidelity trong `run-benchmark`, ghi `fidelity: { verdict: "FALLBACK", reasons: ["DISABLED"] }` (không bao giờ PASS khi tắt).
- Rollback: revert PR (toàn bộ file mới tách trong `benchmarks/src/fidelity/`, `benchmarks/fidelity/`, workflow riêng). Có thể tắt riêng CI bằng disable workflow mà không ảnh hưởng benchmark.

## 15. Tiêu chí chấp nhận đo được

- [ ] Mọi fault trong `inject-faults.ts` (>=10 loại) đều bị phát hiện với đúng mã lý do; 0 false PASS.
- [ ] Ref vs ref (2 run độc lập) PASS cho mọi fixture trên CI.
- [ ] File ngưỡng có >=5 run tham chiếu, kèm cặp thô và nguồn gốc.
- [ ] `fidelity` có trong `turbo-bench-run/2`; `report.ts` đọc được kết quả PR00 cũ không lỗi.
- [ ] Workflow xanh trên PR và có artifact report; job đỏ khi cố ý tiêm lỗi.
- [ ] PR body có: ADR 0002, đo trước/sau (overhead của `--keep-output` và thời gian fidelity, >=5 cặp), báo cáo fidelity, peak RSS của bộ so sánh, chiến lược fallback/rollback, negative results.

## Câu hỏi chưa giải quyết

1. Upstream có xuất frame lossless/PNG-sequence để làm `preEncode` không, hay phải chấp nhận `PRE_ENCODE_UNAVAILABLE` (FALLBACK) cho đến PR02?
2. Upstream biểu diễn fps rational (30000/1001) và motion blur như thế nào? Cần submodule để trả lời ở P0.
3. `benchmarks/src/media.ts` được manifest PR00 nhắc đến nhưng không có trong tree; cần PR00 sửa manifest hoặc thêm file trước khi PR01 dựa vào.
4. Có cho phép thêm fixture mới vào `manifest.json` (làm baseline PR00 phải chạy thêm) hay đặt chúng trong manifest riêng `benchmarks/fixtures/fidelity-manifest.json`? Plan mặc định: manifest riêng nếu maintainer muốn giữ baseline PR00 bất biến.
5. Codec audio upstream đầu ra (AAC?) để chốt độ phân giải đo A/V drift.
