# HyperFrames Turbo

**Experimental render acceleration research for [HyperFrames](https://github.com/heygen-com/hyperframes).**

> Independent project by digitopvn, not affiliated with or endorsed by HeyGen.

## Goal

Maximize end-to-end render throughput, incremental rerender speed and efficiency **without degrading frame fidelity, audio synchronization, alpha/HDR color correctness, resolution, framerate or reliability**.

### Start with the master epic

**[Issue #1: architecture, implementation tracks, benchmark protocol and acceptance criteria](https://github.com/digitopvn/hyperframes-turbo/issues/1)**

## State

- [x] Public Apache-2.0 repository and detailed implementation issue
- [ ] PR00: pin upstream SHA, audit current optimizations, run reproducible baseline and instrument bottlenecks
- [ ] PR01: automated reference fidelity and quality regression gates
- [ ] Subsequent PRs: capture and transport, Scene IR, incremental caching, GPU media/HDR, scheduling and quality-aware encoding

**No speedup claim has been independently measured yet.** All acceleration hypotheses require paired A/B benchmarks, raw data and a fidelity gate.

## Core approach

Render only what changes; move pixel data as little as possible; avoid re-encoding compatible video spans; schedule independent stages concurrently; preserve a trustworthy Chromium fallback. Develop one verified experiment at a time.

## License

Apache-2.0, see [LICENSE](LICENSE). The upstream HyperFrames project is separately Apache-2.0; respect copyright and NOTICE/attribution requirements for redistributed upstream code.
