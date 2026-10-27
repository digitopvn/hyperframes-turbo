/**
 * Upstream configurations under test. Profiles only set upstream's own
 * environment switches; they never enable anything upstream would not do
 * itself for that entry point.
 */
export interface Profile {
  description: string;
  env: Record<string, string>;
  evidence: string;
}

export const PROFILES: Record<string, Profile> = {
  "producer-default": {
    description:
      "Producer API defaults (what packages/producer/src/benchmark.ts and the regression harness exercise): browserGpuMode=software (SwiftShader), which also clamps capture to Page.captureScreenshot.",
    env: {},
    evidence: "upstream packages/engine/src/config.ts:295 (browserGpuMode: \"software\")",
  },
  "cli-local-default": {
    description:
      "What `hyperframes render` does on a local machine with no flags: --browser-gpu resolves to auto (hardware GPU when Chrome can use it) and the software-GPU screenshot clamp is lifted.",
    env: { PRODUCER_BROWSER_GPU_MODE: "auto", PRODUCER_FORCE_SCREENSHOT: "false" },
    evidence:
      "upstream packages/cli/src/browser/gpuPolicy.ts:14 (default \"auto\"), packages/cli/src/commands/render.ts:1098-1105 (forceScreenshot:false for auto)",
  },
};
