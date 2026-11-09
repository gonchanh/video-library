import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExternalDependencies } from "./doctor";
import { applyPlan, cleanupSources, digestPlan, loadPlan, makePlan, sha256, verifyPlan, type MovieCatalog } from "./media";
import { attachMetadata } from "./metadata-plan";
import { metadataHash, metadataPath, renderNfo } from "./jellyfin";
import { parseJellyfinMetadata } from "./structured";

let root: string, fixture: string;
beforeAll(async () => {
  checkExternalDependencies();
  root = await mkdtemp(join(tmpdir(), "video-library-nfo-"));
  fixture = join(root, "fixture.mp4");
  const generated = Bun.spawnSync(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48:r=10:d=1", "-f", "lavfi", "-i", "sine=frequency=400:duration=1", "-c:v", "mpeg4", "-c:a", "aac", "-metadata:s:a:0", "language=eng", fixture], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const metadataInput = {
  kind: "movie", title: "The Fixture", year: 2001, reference: "https://www.imdb.com/title/tt1234567/", provider: "imdb",
  plot: "Only local <metadata> & no remote lookup", genres: ["Test & Drama"], studios: ["Fixture Studio"], directors: ["Director"],
  actors: [{ name: "Actor <One>", role: "Tester & Friend" }], imdbId: "tt1234567", tmdbId: 42,
};
const metadata = parseJellyfinMetadata(JSON.stringify(metadataInput));
async function setup() {
  const base = await mkdtemp(join(root, "case-")), source = join(base, "source"), dest = join(base, "Movies"), run = join(base, "run");
  await mkdir(source); await mkdir(dest);
  const input = join(source, "raw.mp4"); await copyFile(fixture, input);
  const catalog: MovieCatalog = { kind: "movies", reference: metadata.reference, movies: [{ file: "raw.mp4", title: metadata.title, year: 2001, reference: metadata.reference }] };
  const draft = await makePlan(source, dest, catalog, 1);
  return { base, source, dest, run, input, draft, plan: await attachMetadata(draft, { "raw.mp4": metadata }) };
}

test("Jellyfin XML escapes fields and identifies movies and episodes", () => {
  const output = renderNfo(metadata);
  expect(output).toContain("<movie>");
  expect(output).toContain("&lt;metadata&gt; &amp;");
  expect(output).toContain('<uniqueid type="imdb">tt1234567</uniqueid>');
  expect(output).toContain("<role>Tester &amp; Friend</role>");
  const episode = parseJellyfinMetadata(JSON.stringify({ ...metadataInput, kind: "episode", season: 0, episode: 0, showTitle: "Fixture" }));
  expect(renderNfo(episode)).toContain("<episodedetails>");
  expect(renderNfo(episode)).toContain("<episode>0</episode>");
});

test("metadata preflight rejects wrong identities, unknown sources and existing sidecars", async () => {
  const { draft } = await setup();
  await expect(attachMetadata(draft, { "raw.mp4": { ...metadataInput, title: "Different film" } })).rejects.toThrow("identity");
  await expect(attachMetadata(draft, { "other.mp4": metadata })).rejects.toThrow("unplanned source");
  const path = metadataPath(draft.items[0]); await writeFile(path, "keep existing");
  await expect(attachMetadata(draft)).rejects.toThrow("already exists");
  expect(await Bun.file(path).text()).toBe("keep existing");
});

test("late exact and case-folded sidecar collisions stop before video publication", async () => {
  for (const uppercase of [false, true]) {
    const { plan, run, input } = await setup();
    const item = plan.items[0], path = uppercase ? metadataPath(item).replace(/\.nfo$/, ".NFO") : metadataPath(item);
    await writeFile(path, "foreign metadata");
    await expect(applyPlan(plan, run)).rejects.toThrow("metadata collision");
    expect(await Bun.file(item.target).exists()).toBe(false);
    expect(await Bun.file(path).text()).toBe("foreign metadata");
    expect(await sha256(input)).toBe(item.sha256);
  }
});

test("metadata identity accepts display-title punctuation and case without changing filenames", async () => {
  const { source, dest, input } = await setup();
  const file = "Fixture.S01E01.mp4";
  await rename(input, join(source, file));
  const draft = await makePlan(source, dest, { show: "Fixture Show", season: 1, reference: metadata.reference, seasonFolders: false, episodes: [{ episode: 1, title: "Pilot" }] }, 1);
  const supplied = { ...metadataInput, kind: "episode", title: "PILOT", season: 1, episode: 1, showTitle: "Fixture: Show" };
  const plan = await attachMetadata(draft, { [file]: supplied });
  expect(plan.items[0].metadata?.showTitle).toBe("Fixture: Show");
  expect(plan.items[0].target).toContain("Fixture Show - S01E01 - Pilot.mp4");
});

test("publication receipts bind NFO bytes and corruption prevents source deletion", async () => {
  const { base, plan, run, input } = await setup();
  const saved = join(base, "plan.json");
  await writeFile(saved, JSON.stringify(plan));
  expect(digestPlan(await loadPlan(saved))).toBe(digestPlan(plan));
  await applyPlan(plan, run);
  const path = metadataPath(plan.items[0]);
  expect(await sha256(path)).toBe(metadataHash(metadata));
  await verifyPlan(plan, run, true);
  expect(await sha256(input)).toBe(plan.items[0].sha256);
  await appendFile(path, "corrupt");
  await expect(verifyPlan(plan, run)).rejects.toThrow("Metadata hash mismatch");
  await expect(cleanupSources(plan, run, undefined, true)).rejects.toThrow();
  expect(await sha256(input)).toBe(plan.items[0].sha256);
}, 60000);

test("validated video resumes missing metadata without another remux", async () => {
  const { plan, run, dest, input } = await setup();
  await applyPlan(plan, run);
  const item = plan.items[0], name = (await readdir(run)).find(candidate => /^item-[a-f0-9]{64}\.json$/.test(candidate))!;
  const record = await Bun.file(join(run, name)).json();
  // Reproduce persisted state after checked video publication, before NFO/receipt publication.
  await rm(join(run, name)); await rm(metadataPath(item));
  const tempDir = await mkdtemp(join(dest, ".video-library-"));
  await writeFile(join(run, name.replace(/\.json$/, ".checkpoint.json")), JSON.stringify({
    version: 1, planSha256: digestPlan(plan), source: item.source, target: item.target, sourceSha256: item.sha256,
    tempDir, stage: "validated", outputSha256: record.outputSha256, fullDecode: true,
  }));
  const before = await sha256(item.target);
  await applyPlan(plan, run, undefined, true);
  expect(await sha256(item.target)).toBe(before);
  expect(await sha256(metadataPath(item))).toBe(metadataHash(metadata));
  expect(await sha256(input)).toBe(item.sha256);
  await verifyPlan(plan, run);
}, 60000);
