import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExternalDependencies } from './doctor';
import { applyPlan, digestPlan, isMovieCatalog, loadPlan, makePlan, probe, sha256, verifyPlan, type MovieCatalog, type TvCatalog } from './media';

const catalog: MovieCatalog = { kind: 'movies', reference: 'https://www.imdb.com/', movies: [
  { file: 'incoming/Matrix.mp4', title: 'The Matrix', year: 1999, reference: 'https://www.imdb.com/title/tt0133093/' },
  { file: 'Missing.mp4', title: 'Lost: & Found?', year: 2004, reference: 'https://www.imdb.com/title/tt1234567/' },
] };
const tv: TvCatalog = { show: 'Show', season: 1, reference: 'https://example.org/episodes', seasonFolders: false, episodes: [{ episode: 1, title: 'Pilot' }] };
let temp: string, fixture: string;
beforeAll(async () => {
  checkExternalDependencies();
  temp = await mkdtemp(join(tmpdir(), 'movies-test-'));
  fixture = join(temp, 'fixture.mp4');
  const result = Bun.spawnSync(['ffmpeg', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'mpeg4', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', fixture]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
});
afterAll(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });
async function setup() {
  const base = await mkdtemp(join(temp, 'case-'));
  const source = join(base, 'source'), dest = join(base, 'dest'), run = join(base, 'run');
  await mkdir(source); await mkdir(dest); await mkdir(join(source, 'incoming'));
  const input = join(source, 'incoming', 'Matrix.mp4');
  await copyFile(fixture, input);
  return { source, dest, run, input, base };
}

test('explicit source mapping, The naming, punctuation, flat outputs, missing IDs and plan digest', async () => {
  const { source, dest, input, base } = await setup();
  const plan = await makePlan(source, dest, catalog, 1);
  expect(isMovieCatalog(plan.catalog)).toBe(true);
  expect(plan.items[0].source).toBe(input);
  expect(plan.items[0].title).toBe('Matrix, The - 1999');
  expect(plan.items[0].target).toBe(join(dest, 'Matrix, The - 1999.mp4'));
  expect(plan.missing).toEqual(['Lost & Found - 2004']);
  expect(digestPlan({ ...plan, catalog: { ...catalog, movies: [{ ...catalog.movies[0], reference: 'https://example.org/another' }, catalog.movies[1]] } })).not.toBe(digestPlan(plan));
  const path = join(base, 'plan.json'); await writeFile(path, JSON.stringify(plan));
  expect((await loadPlan(path)).items[0].target).toBe(plan.items[0].target);
  plan.items[0].target = join(dest, 'somewhere', 'Matrix, The - 1999.mp4');
  await writeFile(path, JSON.stringify(plan));
  await expect(loadPlan(path)).rejects.toThrow('Invalid item mapping');
});

test('rejects missing references, invalid source paths, year bounds and duplicate names or files', async () => {
  const { source, dest } = await setup();
  const entry = catalog.movies[0];
  for (const change of [{ reference: '' }, { title: '' }, { year: 1887 }, { year: 2101 }, { file: '../Matrix.mp4' }, { file: '/tmp/Matrix.mp4' }, { file: 'incoming\\Matrix.mp4' }, { file: 'C:/Matrix.mp4' }, { file: 'incoming//Matrix.mp4' }]) {
    await expect(makePlan(source, dest, { ...catalog, movies: [{ ...entry, ...change }] })).rejects.toThrow();
  }
  for (const duplicate of [{ ...entry, file: 'incoming/matrix.mp4' }, { ...entry, file: 'different.mp4', title: 'the matrix' }]) {
    await expect(makePlan(source, dest, { ...catalog, movies: [entry, duplicate] })).rejects.toThrow('Duplicate movie');
  }
  await expect(makePlan(source, dest, { ...catalog, reference: 'file:///tmp/catalog' })).rejects.toThrow();
  await expect(makePlan(source, dest, { ...catalog, movies: [{ ...entry, title: 'CON' }] })).rejects.toThrow('Unsafe filename');
});

test('unknown inputs, TV files, nested or season destinations and collisions fail closed', async () => {
  const { source, dest } = await setup();
  await copyFile(fixture, join(source, 'wrong.mp4'));
  await expect(makePlan(source, dest, catalog)).rejects.toThrow('Out-of-catalog');
  await rm(join(source, 'wrong.mp4'));
  await copyFile(fixture, join(dest, 'Show - S01E01 - Pilot.mp4'));
  await expect(makePlan(source, dest, catalog)).rejects.toThrow();
  await rm(join(dest, 'Show - S01E01 - Pilot.mp4'));
  await mkdir(join(dest, 'SEASON 1'));
  await expect(makePlan(source, dest, catalog)).rejects.toThrow('flat');
  await rm(join(dest, 'SEASON 1'), { recursive: true });
  await mkdir(join(dest, 'Nested'));
  await expect(makePlan(source, dest, catalog)).rejects.toThrow('flat');
  await rm(join(dest, 'Nested'), { recursive: true });
  await copyFile(fixture, join(dest, 'matrix, the - 1999.mp4'));
  await expect(makePlan(source, dest, catalog)).rejects.toThrow('Duplicate/colliding');
  await rm(join(dest, 'matrix, the - 1999.mp4'));
  await copyFile(fixture, join(dest, 'Matrix, The - 1999.MP4'));
  await expect(makePlan(source, dest, catalog)).rejects.toThrow('Duplicate/colliding');
});

test('existing movies count towards completeness without an incoming file; TV rejects movie destination', async () => {
  const { source, dest, input } = await setup();
  await rm(input);
  await copyFile(fixture, join(dest, 'Matrix, The - 1999.mp4'));
  const plan = await makePlan(source, dest, catalog);
  expect(plan.items).toEqual([]);
  expect(plan.existing).toEqual(['Matrix, The - 1999']);
  expect(plan.missing).toEqual(['Lost & Found - 2004']);
  await expect(makePlan(source, dest, tv)).rejects.toThrow();
});

test('apply rejects newly discovered source videos and changed source mapping', async () => {
  const { source, dest, run, input } = await setup();
  const plan = await makePlan(source, dest, catalog);
  await copyFile(fixture, join(source, 'other.mp4'));
  await expect(applyPlan(plan, run)).rejects.toThrow('New, duplicate or unplanned source');
  await rm(join(source, 'other.mp4'));
  const changed = { ...plan, catalog: { ...catalog, movies: [{ ...catalog.movies[0], file: 'incoming/other.mp4' }, catalog.movies[1]] } };
  await expect(applyPlan(changed, run)).rejects.toThrow('Unknown source in plan');
  expect(await Bun.file(input).exists()).toBe(true);
});

test('movie language overrides use the same source-relative stream policy', async () => {
  const { source, dest } = await setup();
  await expect(makePlan(source, dest, { ...catalog, languageOverrides: { 'wrong.mp4': { '1': 'eng' } } })).rejects.toThrow('Unknown language override source');
  await expect(makePlan(source, dest, { ...catalog, languageOverrides: { 'incoming/Matrix.mp4': { '0': 'eng' } } })).rejects.toThrow('audio or subtitle');
  const plan = await makePlan(source, dest, { ...catalog, languageOverrides: { 'incoming/Matrix.mp4': { '1': 'eng' } } });
  expect(plan.catalog.languageOverrides?.['incoming/Matrix.mp4']).toEqual({ '1': 'eng' });
});

test('real MP4 remux applies, full-decodes, retains source and checks destination changes', async () => {
  const { source, dest, run, input } = await setup();
  const plan = await makePlan(source, dest, catalog);
  const original = await sha256(input);
  await applyPlan(plan, run, 1);
  expect(await sha256(input)).toBe(original);
  expect((await readdir(dest)).filter(name => name.endsWith('.mp4'))).toEqual(['Matrix, The - 1999.mp4']);
  expect((await probe(plan.items[0].target)).format.tags?.title).toBe('Matrix, The - 1999');
  await verifyPlan(plan, run, true, 1);
  await applyPlan(plan, run, 1, true);
  await copyFile(fixture, join(dest, 'Lost & Found - 2004.mp4'));
  await expect(applyPlan(plan, run, 1, true)).rejects.toThrow('Destination completeness changed');
  expect(await sha256(input)).toBe(original);
}, 60000);
