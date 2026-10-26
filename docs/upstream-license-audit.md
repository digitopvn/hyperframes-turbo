# Upstream license audit

Pinned upstream: `heygen-com/hyperframes` at `1c4a1c162033f22935c0c315efc5245b0cd6ac5d` (submodule `upstream/hyperframes`). Audit date: 2026-10-27.

## Findings

| Item | Evidence at the pinned SHA | Obligation for this repository |
|---|---|---|
| Upstream license | `LICENSE` is the Apache License 2.0 text, `Copyright 2026 HeyGen, Inc.` (line 178) | Keep the license with any redistributed upstream code; state changes to modified files (§4b). |
| Package licenses | Every `packages/*/package.json` declares `"license": "Apache-2.0"` | Same as above. |
| Upstream NOTICE | No `NOTICE` file at the root | §4d has nothing to propagate. Our own [`NOTICE`](../NOTICE) gives attribution anyway. |
| Trademarks | Apache-2.0 §6 grants no trademark rights; `README.md` names HeyGen as a production user | Use "HyperFrames"/"HeyGen" only to identify the upstream project. Do not imply affiliation (README and NOTICE both state independence). |
| GSAP (fixture runtime dependency) | `gsap@3.15.0` `package.json`: `"Standard 'no charge' license"`; the header reads "Copyright 2026, GreenSock. All rights reserved." | **Not Apache-2.0.** Do not commit `gsap.min.js`. The harness copies it from `upstream/hyperframes/node_modules` into a temp dir at run time (`benchmarks/src/fixtures.ts`, `VENDOR_FILES`). |
| Fixture media | Generated locally by FFmpeg `lavfi` sources from `benchmarks/fixtures/media-recipes.json` (testsrc2, sine) | No third-party content. Generated files are cached under `benchmarks/.cache/` (gitignored), not committed. |
| Upstream fixtures used (`webm-transparency`, `hdr-hlg-regression`, `hdr-regression`) | Read in place from `packages/producer/tests/` in the submodule | Not copied into this repo. They stay under the upstream license and in the upstream tree. |

## How this repository uses upstream

- Upstream source is **unmodified**. The harness imports `packages/producer` and `packages/engine` TypeScript at run time through `tsx`. It observes behaviour from outside: through the logger, a puppeteer `Connection` byte tap installed in memory only, and host samplers.
- Nothing from upstream is vendored into `benchmarks/`. If a later PR forks upstream files, those files must keep the Apache header and carry a prominent change notice (§4b).
- This repository is itself Apache-2.0 ([`LICENSE`](../LICENSE)).

## Checklist for future PRs

- [ ] Any copied or forked upstream file keeps its license and is marked as modified.
- [ ] No GSAP, fonts or media with non-Apache terms are committed without a recorded license review.
- [ ] Docs, PR titles and release notes do not imply that HeyGen endorses this work.
