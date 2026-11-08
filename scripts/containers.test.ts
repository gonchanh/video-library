import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkContainer, containerProfile, targetExtension } from './containers';
import { applyPlan, effectiveProbe, makePlan, probe, verifyPlan, type Catalog, type Probe } from './media';
import { checkExternalDependencies } from './doctor';

const catalog: Catalog = { show: 'Format Test', season: 1, reference: 'https://example.org/episodes', seasonFolders: false, episodes: [{ episode: 1, title: 'Pilot' }] };
const sample: Probe = { streams: [
  { index: 0, codec_type: 'video', codec_name: 'h264' },
  { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng' } },
  { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', title: 'English' } },
], format: { duration: '1' }, chapters: [] };

test('profiles preserve the source extension by default and never silently substitute MKV', () => {
  for (const ext of ['.mkv', '.mp4', '.m4v', '.mov', '.webm', '.avi', '.ts', '.m2ts', '.mts', '.wmv', '.flv', '.mpg', '.mpeg', '.ogv']) {
    expect(targetExtension(`episode${ext}`)).toBe(ext);
    expect(containerProfile(ext).limitations.length).toBeGreaterThan(20);
  }
  expect(targetExtension('episode.MP4')).toBe('.mp4');
  expect(targetExtension('episode.mkv', '.mp4')).toBe('.mp4');
  expect(() => targetExtension('episode.xyz')).toThrow('Unsupported output container');
});
test('rejects incompatible selected tracks or metadata before remux', () => {
  expect(() => checkContainer(containerProfile('.mp4'), sample, [0, 1, 2])).toThrow('mov_text');
  expect(() => checkContainer(containerProfile('.webm'), sample, [0, 1])).toThrow('WebM-compatible');
  for (const ext of ['.avi', '.ts', '.m2ts', '.mts', '.flv', '.mpg', '.mpeg', '.ogv']) {
    expect(() => checkContainer(containerProfile(ext), { ...sample, chapters: [{}] }, [0, 1])).toThrow('chapters');
    expect(() => checkContainer(containerProfile(ext), sample, [0, 1, 2])).toThrow('subtitle');
  }
  expect(() => checkContainer(containerProfile('.avi'), sample, [0, 1])).not.toThrow();
  const xsub = { ...sample, streams: sample.streams.map(s => s.codec_type === 'subtitle' ? { ...s, codec_name: 'xsub' } : s) };
  expect(() => checkContainer(containerProfile('.avi'), xsub, [0, 1, 2])).not.toThrow();
  expect(() => checkContainer(containerProfile('.wmv'), { ...sample, chapters: [{}] }, [0, 1])).toThrow('chapters');
});

let temp: string;
beforeAll(async () => { checkExternalDependencies(); temp = await mkdtemp(join(tmpdir(), 'video-library-containers-test-')); });
afterAll(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });
function ffmpeg(args: string[]) {
  const result = Bun.spawnSync(['ffmpeg', '-nostdin', '-v', 'error', '-n', ...args], { timeout: 30000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
async function caseDirs(ext: string) {
  const base = await mkdtemp(join(temp, 'case-'));
  const source = join(base, 'source'), destination = join(base, 'destination'), run = join(base, 'run');
  await mkdir(source); await mkdir(destination);
  return { source, destination, run, input: join(source, `Format.Test.S01E01${ext}`), base };
}
test('real MP4 retains the extension, title, chapters, stream copy, and verification', async () => {
  const ctx = await caseDirs('.mp4');
  const chapters = join(ctx.base, 'chapters.ffmeta');
  await writeFile(chapters, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=700\ntitle=Intro\n');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-f', 'ffmetadata', '-i', chapters,
    '-map', '0:v', '-map', '1:a', '-map_chapters', '2', '-c:v', 'mpeg4', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', ctx.input]);
  const plan = await makePlan(ctx.source, ctx.destination, catalog);
  expect(plan.items[0].target).toEndWith('.mp4');
  expect(plan.items[0].probe.chapters).toHaveLength(1);
  await applyPlan(plan, ctx.run);
  const output = await probe(plan.items[0].target);
  expect(output.chapters).toHaveLength(1);
  expect(output.format.tags?.title).toBe(plan.items[0].title);
  await verifyPlan(plan, ctx.run, true);
}, 60000);
test('MP4 mov_text subtitles retain English labels through handler_name', async () => {
  const ctx = await caseDirs('.mp4');
  const subtitle = join(ctx.base, 'English.srt');
  await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:00,700\nHello\n');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-i', subtitle,
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'mpeg4', '-c:a', 'aac', '-c:s', 'mov_text',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'handler_name=English SDH', ctx.input]);
  const plan = await makePlan(ctx.source, ctx.destination, catalog);
  await applyPlan(plan, ctx.run);
  const output = await probe(plan.items[0].target);
  expect(output.streams[2].tags?.handler_name).toBe('English SDH');
  expect(output.streams[2].tags?.language).toBe('eng');
  await verifyPlan(plan, ctx.run);
}, 60000);
test('real WebM retains the extension and English audio without transcoding', async () => {
  const ctx = await caseDirs('.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'libvpx', '-c:a', 'libopus', '-metadata:s:a:0', 'language=eng', ctx.input]);
  const plan = await makePlan(ctx.source, ctx.destination, catalog);
  expect(plan.items[0].target).toEndWith('.webm');
  await applyPlan(plan, ctx.run);
  const output = await probe(plan.items[0].target);
  expect(output.streams.map(stream => stream.codec_name)).toEqual(['vp8', 'opus']);
  expect(output.format.tags?.title).toBe(plan.items[0].title);
  await verifyPlan(plan, ctx.run, true);
}, 60000);
test('chapterless WMV retains its English audio and title through ASF', async () => {
  const ctx = await caseDirs('.wmv');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'wmv2', '-c:a', 'wmav2', '-metadata:s:a:0', 'language=eng', ctx.input]);
  const plan = await makePlan(ctx.source, ctx.destination, catalog);
  await applyPlan(plan, ctx.run);
  const output = await probe(plan.items[0].target);
  expect(output.streams.map(stream => stream.codec_name)).toEqual(['wmv2', 'wmav2']);
  expect(output.format.tags?.title).toBe(plan.items[0].title);
  await verifyPlan(plan, ctx.run);
}, 60000);
test('untagged AVI requires confirmed source-relative audio mapping; preserves AVI and receipt', async () => {
  const ctx = await caseDirs('.avi');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'mpeg4', '-c:a', 'mp3', ctx.input]);
  await expect(makePlan(ctx.source, ctx.destination, catalog)).rejects.toThrow('Unknown language');
  const languageOverrides = { 'Format.Test.S01E01.avi': { '1': 'eng' } };
  const plan = await makePlan(ctx.source, ctx.destination, { ...catalog, languageOverrides });
  expect(plan.items[0].target).toEndWith('.avi');
  expect(plan.items[0].probe.streams[1].tags?.language).toBeUndefined();
  expect(effectiveProbe(plan, plan.items[0]).streams[1].tags?.language).toBe('eng');
  await applyPlan(plan, ctx.run);
  const output = await probe(plan.items[0].target);
  expect(output.streams.map(s => s.codec_name)).toEqual(['mpeg4', 'mp3']);
  expect(output.format.tags?.title).toBe(plan.items[0].title);
  await verifyPlan(plan, ctx.run, true);
}, 60000);
test('TS retains its streams and English language while omitting unsupported title/default flags', async () => {
  const ctx = await caseDirs('.ts');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'mpeg2video', '-c:a', 'mp2', '-metadata:s:a:0', 'language=eng', ctx.input]);
  const plan = await makePlan(ctx.source, ctx.destination, catalog);
  await applyPlan(plan, ctx.run);
  const output = await probe(plan.items[0].target);
  expect(output.streams.map(s => s.codec_name)).toEqual(['mpeg2video', 'mp2']);
  expect(output.streams[1].tags?.language).toBe('eng');
  await verifyPlan(plan, ctx.run);
}, 60000);
test('FLV preserves compatible AV tracks with explicitly mapped untagged audio', async () => {
  const ctx = await caseDirs('.flv');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'flv', '-c:a', 'mp3', ctx.input]);
  const raw = await probe(ctx.input);
  const audio = raw.streams.find(s => s.codec_type === 'audio')!;
  const plan = await makePlan(ctx.source, ctx.destination, { ...catalog, languageOverrides: { 'Format.Test.S01E01.flv': { [audio.index]: 'eng' } } });
  await applyPlan(plan, ctx.run);
  const output = await probe(plan.items[0].target);
  expect(output.streams.map(s => s.codec_name)).toEqual(['mp3', 'flv1']);
  expect(output.format.tags?.title).toBe(plan.items[0].title);
  await verifyPlan(plan, ctx.run);
}, 60000);
test('rejects typo, malformed, unsafe and irrelevant language overrides', async () => {
  const ctx = await caseDirs('.avi');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'mpeg4', '-c:a', 'mp3', ctx.input]);
  const overrides = (file: string, index: string, language: string) => ({ ...catalog, languageOverrides: { [file]: { [index]: language } } });
  const file = 'Format.Test.S01E01.avi';
  await expect(makePlan(ctx.source, ctx.destination, overrides('wrong.avi', '1', 'eng'))).rejects.toThrow('Unknown language override source');
  await expect(makePlan(ctx.source, ctx.destination, overrides('../wrong.avi', '1', 'eng'))).rejects.toThrow('Invalid language override');
  await expect(makePlan(ctx.source, ctx.destination, overrides('/tmp/other.avi', '1', 'eng'))).rejects.toThrow('Invalid language override');
  await expect(makePlan(ctx.source, ctx.destination, overrides(file, '99', 'eng'))).rejects.toThrow('audio or subtitle');
  await expect(makePlan(ctx.source, ctx.destination, overrides(file, '0', 'eng'))).rejects.toThrow('audio or subtitle');
  await expect(makePlan(ctx.source, ctx.destination, overrides(file, '1', 'und'))).rejects.toThrow('Invalid language override');
  await expect(makePlan(ctx.source, ctx.destination, overrides(file, '1', 'ENG'))).rejects.toThrow('Invalid language override');
}, 60000);
test('MP4 override with incompatible subtitles refuses planning and never creates output', async () => {
  const ctx = await caseDirs('.mkv');
  const subtitle = join(ctx.base, 'English.srt');
  await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:00,700\nHello\n');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-i', subtitle,
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'mpeg4', '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:a:0', 'language=eng',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English', ctx.input]);
  await expect(makePlan(ctx.source, ctx.destination, { ...catalog, container: '.mp4' })).rejects.toThrow('mov_text');
  const intact = await probe(ctx.input);
  expect(intact.streams).toHaveLength(3);
});
