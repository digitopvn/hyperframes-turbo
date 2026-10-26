# Agent instructions

Read and execute the [master epic #1](https://github.com/digitopvn/hyperframes-turbo/issues/1). Begin with **PR00** (pinned upstream + benchmark baseline), followed by **PR01** (automated fidelity gates), before acceleration implementation.

## Non-negotiables

- Zero silent downgrades to output resolution, frame rate, audio, alpha, HDR, motion blur or video quality.
- No invented benchmarks or claims. Use pinned hardware/browser/FFmpeg/upstream SHA, identical fixtures and settings, >=5 paired warm runs, and cold-start results separately.
- Include full wall time, stage critical path, throughput, p50/p95, memory/VRAM, readback bytes, disk IO, cache hit, quality metrics and cost/minute.
- Compare frames and timing against the reference Chromium backend. Test dropped/reordered frames, VFR input, cuts, alpha, HDR metadata and audio sync.
- Keep capability checks, feature flags, fail-closed fallback and rollback for every experimental backend.
- Treat zero-copy as an experimentally verified property, not a promise. Do not rebuild arbitrary CSS/HTML layout from scratch.
- Keep security isolation and copyright obligations. Publish failed hypotheses too.

## Every PR must include

Architecture decision, before/after reproducible measurements, quality/fidelity report, impact on peak resources, fallback and rollback strategy.
