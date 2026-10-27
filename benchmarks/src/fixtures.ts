/** Fixture discovery, generated media and per-run project preparation. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(BENCH_ROOT, "..");
export const UPSTREAM_ROOT = join(REPO_ROOT, "upstream", "hyperframes");
export const UPSTREAM_TESTS = join(UPSTREAM_ROOT, "packages", "producer", "tests");
export const MEDIA_CACHE = join(BENCH_ROOT, ".cache", "media");

export interface FixtureEntry {
  id: string;
  source: "local" | "upstream";
  category: string;
  vendor: string[];
  media: string[];
}

export interface FixtureMeta {
  name: string;
  tags?: string[];
  renderConfig: {
    fps: number | string;
    format?: string;
    workers?: number;
    hdr?: boolean;
    variables?: Record<string, unknown>;
    /** Upstream engine sub-frame motion blur (`RenderConfig.motionBlur`); absent = off. */
    motionBlur?: Record<string, unknown>;
  };
}

export interface ResolvedFixture extends FixtureEntry {
  dir: string;
  meta: FixtureMeta;
}

/** Which fixture list to load: the PR00 baseline set, the fidelity-only set, or both. */
export type FixtureSet = "baseline" | "fidelity" | "all";

function readFixtureList(file: string): FixtureEntry[] {
  const raw = JSON.parse(readFileSync(join(BENCH_ROOT, "fixtures", file), "utf8"));
  if (!Array.isArray(raw.fixtures)) throw new Error(`${file}: 'fixtures' must be an array`);
  return raw.fixtures as FixtureEntry[];
}

/**
 * Baseline benchmark fixtures (manifest.json) by default. The fidelity-only
 * fixtures live in fidelity-manifest.json so the baseline set never changes
 * when fidelity coverage grows.
 */
export function loadManifest(set: FixtureSet = "baseline"): FixtureEntry[] {
  const baseline = set === "fidelity" ? [] : readFixtureList("manifest.json");
  const fidelity = set === "baseline" ? [] : readFixtureList("fidelity-manifest.json");
  const all = [...baseline, ...fidelity];
  const dup = all.find((f, i) => all.findIndex((g) => g.id === f.id) !== i);
  if (dup) throw new Error(`fixture id ${dup.id} is listed twice across manifests`);
  return all;
}

export function resolveFixture(entry: FixtureEntry): ResolvedFixture {
  const dir = entry.source === "local" ? join(BENCH_ROOT, "fixtures", entry.id) : join(UPSTREAM_TESTS, entry.id);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as FixtureMeta;
  return { ...entry, dir, meta };
}

const VENDOR_FILES: Record<string, { from: string; to: string }> = {
  gsap: {
    from: join(UPSTREAM_ROOT, "node_modules", ".bun", "gsap@3.15.0", "node_modules", "gsap", "dist", "gsap.min.js"),
    to: "gsap.min.js",
  },
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Streaming SHA-256 of a render output: a file, or a png-sequence directory's files in name order. */
export async function sha256Output(path: string): Promise<string> {
  const h = createHash("sha256");
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .sort()
        .map((n) => join(path, n))
    : [path];
  for (const f of files) {
    if (files.length > 1) h.update(f.slice(path.length));
    for await (const chunk of createReadStream(f)) h.update(chunk as Buffer);
  }
  return h.digest("hex");
}

/** Generate (or reuse) a media file from its recipe; returns its path and hash. */
export function ensureMedia(name: string): { path: string; sha256: string; recipe: string[] } {
  const recipes = JSON.parse(readFileSync(join(BENCH_ROOT, "fixtures", "media-recipes.json"), "utf8"));
  const recipe = recipes[name] as string[] | undefined;
  if (!recipe) throw new Error(`No media recipe for ${name}`);
  const key = createHash("sha256").update(JSON.stringify(recipe)).digest("hex").slice(0, 12);
  const path = join(MEDIA_CACHE, key, name);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.partial${name.slice(name.lastIndexOf("."))}`;
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...recipe, tmp], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${r.stderr}`);
    renameSync(tmp, path);
  }
  return { path, sha256: sha256File(path), recipe };
}

export interface PreparedInputs {
  media: Record<string, { sha256: string; recipe: string[] }>;
  vendor: Record<string, { sha256: string; from: string }>;
}

/** Copy the fixture's src plus vendor/media into `projectDir` (a fresh temp dir). */
export function prepareProject(fx: ResolvedFixture, projectDir: string): PreparedInputs {
  rmSync(projectDir, { recursive: true, force: true });
  cpSync(join(fx.dir, "src"), projectDir, { recursive: true });
  const inputs: PreparedInputs = { media: {}, vendor: {} };
  for (const v of fx.vendor) {
    const spec = VENDOR_FILES[v];
    if (!spec || !existsSync(spec.from)) throw new Error(`Vendor file missing for ${v}: ${spec?.from}`);
    cpSync(spec.from, join(projectDir, spec.to));
    inputs.vendor[v] = { sha256: sha256File(spec.from), from: spec.from.slice(REPO_ROOT.length + 1) };
  }
  for (const m of fx.media) {
    const gen = ensureMedia(m);
    mkdirSync(join(projectDir, "media"), { recursive: true });
    cpSync(gen.path, join(projectDir, "media", m));
    inputs.media[m] = { sha256: gen.sha256, recipe: gen.recipe };
  }
  return inputs;
}

/** Hash of the fixture's source tree (index.html + assets), for result provenance. */
export function hashFixtureSource(fx: ResolvedFixture): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSorted(d)) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p.slice(fx.dir.length)).update(readFileSync(p));
    }
  };
  walk(join(fx.dir, "src"));
  h.update(readFileSync(join(fx.dir, "meta.json")));
  return h.digest("hex");
}

function readdirSorted(d: string): Dirent[] {
  return readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
}
