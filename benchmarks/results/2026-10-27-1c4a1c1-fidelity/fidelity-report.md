# Fidelity report: producer-default run 2 vs producer-default run 1

- Overall verdict: **PASS** (exit code 0)
- Threshold path: `producer-default.win32`
- Tools: ffmpeg version 8.0-essentials_build-www.gyan.dev Copyright (c) 2000-2025 the FFmpeg developers; libvmaf available
- Peak RSS is the comparator Node process (FFmpeg children excluded).

| fixture | verdict | reasons | frames ref/cand | sampled | worst sampled PSNR dB | worst sampled SSIM | worst-frame PSNR (all frames) dB | VMAF min | A/V drift ms | wall s | peak RSS MiB |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| audio-mix | **PASS** | — | 240/240 | 27 | ∞ | 1.000000 | ∞ | 97.428 | 0.00 | 4.6 | 251 |
| canvas-webgl | **PASS** | — | 180/180 | 12 | ∞ | 1.000000 | ∞ | 97.427 | — | 4.3 | 256 |
| css-filters-blend | **PASS** | — | 180/180 | 13 | ∞ | 1.000000 | ∞ | 97.428 | — | 3.7 | 256 |
| fps-ntsc-30000-1001 | **PASS** | — | 240/240 | 15 | 57.68 | 0.999862 | 62.30 | 97.371 | — | 4.4 | 256 |
| gsap-static-holds | **PASS** | — | 300/300 | 21 | 58.33 | 0.999871 | 55.29 | 96.991 | — | 5.3 | 256 |
| hdr-hlg-regression | **PASS** | — | 150/150 | 13 | ∞ | 1.000000 | ∞ | — | — | 3.3 | 269 |
| hdr-regression | **PASS** | — | 180/180 | 18 | ∞ | 1.000000 | ∞ | — | — | 3.1 | 269 |
| mixed-complex | **PASS** | — | 300/300 | 23 | ∞ | 1.000000 | ∞ | 97.428 | 0.00 | 6.5 | 269 |
| motion-blur | **PASS** | — | 90/90 | 17 | 55.96 | 0.999533 | 60.64 | 97.331 | — | 2.7 | 269 |
| transition-crossfade | **PASS** | — | 150/150 | 16 | ∞ | 1.000000 | ∞ | 97.428 | — | 3.3 | 269 |
| typography-svg | **PASS** | — | 240/240 | 18 | ∞ | 1.000000 | ∞ | 97.428 | — | 4.1 | 269 |
| video-heavy | **PASS** | — | 240/240 | 23 | ∞ | 1.000000 | ∞ | 97.428 | — | 4.8 | 269 |
| webm-transparency | **PASS** | — | 60/60 | 13 | ∞ | 1.000000 | ∞ | — | — | 0.5 | 269 |
