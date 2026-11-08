import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { resolveJobs, runQueue } from './queue';
import { withRunLock } from './run-lock';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';

export type Stream = { index: number; codec_type: string; codec_name: string; width?: number; height?: number; channels?: number; tags?: Record<string, string>; disposition?: Record<string, number> };
export type Probe = { streams: Stream[]; format: { duration?: string; tags?: Record<string, string> }; chapters?: unknown[] };
export type Catalog = { show: string; season: number; reference: string; episodes: { episode: number; title: string }[]; seasonFolders: boolean };
export type Item = { source: string; target: string; title: string; sha256: string; probe: Probe; selected: number[] };
export type Plan = { version: 1; sourceRoot: string; destinationRoot: string; catalog: Catalog; items: Item[]; missing: string[]; existing: string[]; ignored: string[]; createdAt: string };
type Receipt = { source: string; target: string; sourceSha256: string; outputSha256: string; fullDecode: true };
type RunManifest = { version: 1; planSha256: string };
type Checkpoint = { version: 1; planSha256: string; source: string; target: string; sourceSha256: string; tempDir: string; stage: 'working' | 'validated'; outputSha256?: string; fullDecode?: true };
const videos = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.webm', '.ts']);
const shaPattern = /^[0-9a-f]{64}$/;
const idPattern = /(?<!\d)S\d{2}E\d{2}(?!\d)/gi;
const text = (v: unknown): v is string => typeof v === 'string';
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (message: string): never => { throw new Error(message); };
const within = (parent: string, child: string) => { const rel = relative(parent, child); return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const ident = (season: number, episode: number) => `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

async function exec(args: string[], logfile?: string): Promise<string> {
  const command = args[0] === 'ffmpeg' ? ['nice', '-n', '15', ...args] : args;
  if (logfile) await writeFile(logfile, `$ ${command.map(a => JSON.stringify(a)).join(' ')}\n`, { flag: 'a' });
  const proc = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let stderrTail = '', stdout = '';
  async function consume(stream: ReadableStream<Uint8Array>, isError: boolean) {
    const decoder = new TextDecoder();
    const remember = (part: string) => {
      if (isError) stderrTail = (stderrTail + part).slice(-2000);
      else if (!logfile || args[0] === 'ffprobe') stdout += part;
    };
    try {
      for await (const chunk of stream) {
        if (logfile) await writeFile(logfile, chunk, { flag: 'a' });
        remember(decoder.decode(chunk, { stream: true }));
      }
      remember(decoder.decode());
    } catch (error) {
      proc.kill('SIGKILL');
      throw error;
    }
  }
  const results = await Promise.allSettled([consume(proc.stdout, false), consume(proc.stderr, true), proc.exited]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const status = await proc.exited;
  if (status !== 0) fail(`${args[0]} failed (${status}): ${stderrTail}`);
  return stdout;
}
export async function probe(path: string): Promise<Probe> {
  const result: unknown = JSON.parse(await exec(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', path]));
  if (!obj(result) || !Array.isArray(result.streams) || !obj(result.format)) fail(`Invalid ffprobe output: ${path}`);
  return result as Probe;
}
export async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function episodeId(name: string): string | null {
  const ids = [...name.matchAll(idPattern)];
  if (!ids.length) return null;
  const tail = name.slice((ids[0].index ?? 0) + ids[0][0].length);
  if (ids.length !== 1 || /E\d{2}/i.test(tail) || /^[-_]\d{2}(?!\d)/.test(tail)) fail(`Multiple episodes in ${name}`);
  return ids[0][0].toUpperCase();
}
export function safeName(input: string): string {
  if (!text(input)) fail('Invalid filename');
  // Control characters are intentionally removed from portable filenames.
  // eslint-disable-next-line no-control-regex
  const name = input.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').replace(/[ .]+$/g, '').trim();
  if (!name || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) fail(`Unsafe filename: ${input}`);
  return name;
}
const lang = (s: Stream) => s.tags?.language?.toLowerCase();
const english = (s: Stream) => ['eng', 'en'].includes(lang(s) ?? '');
const sdh = (s: Stream) => /\b(sdh|hearing[ -]?impaired)\b/i.test(s.tags?.title ?? '') || s.disposition?.hearing_impaired === 1;
export function chooseStreams(p: Probe): number[] {
  if (!Array.isArray(p.streams)) fail('Missing streams');
  for (const s of p.streams) if (['audio', 'subtitle'].includes(s.codec_type) && (!lang(s) || lang(s) === 'und')) fail(`Unknown language on stream ${s.index}; provide explicit mapping before planning`);
  const video = p.streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = p.streams.filter(s => s.codec_type === 'audio' && english(s));
  if (!video) throw new Error('Requires primary video');
  if (!audio.length) throw new Error('Requires English audio');
  const subtitles = p.streams.filter(s => s.codec_type === 'subtitle' && english(s));
  const font = p.streams.some(s => s.codec_type === 'attachment' && (/font|truetype|opentype/i.test(s.tags?.mimetype ?? '') || /\.(ttf|otf)$/i.test(s.tags?.filename ?? '') || /^(ttf|otf)$/i.test(s.codec_name)));
  if (font && subtitles.some(s => ['ass', 'ssa'].includes(s.codec_name))) fail('Styled subtitles have embedded fonts; review attachment retention before planning');
  const unclassified = subtitles.filter(s => !sdh(s) && (!s.tags?.title?.trim() || /^(english|en|eng)$/i.test(s.tags.title.trim())));
  if (unclassified.length > 1) fail('Ambiguous English subtitle tracks; confirm regular versus SDH labels before planning');
  return [video.index, ...audio.map(s => s.index), ...subtitles.map(s => s.index)];
}
export function ffmpegArgs(item: Item, output: string): string[] {
  const selected = item.selected.map(i => item.probe.streams.find(s => s.index === i) ?? fail(`Unknown stream ${i}`));
  const args = ['ffmpeg', '-nostdin', '-n', '-v', 'warning', '-i', item.source];
  for (const s of selected) args.push('-map', `0:${s.index}`);
  args.push('-map_chapters', '0', '-map_metadata', '-1', '-map_metadata:s', '-1', '-c', 'copy', '-metadata', `title=${item.title}`);
  let a = 0, sub = 0, v = 0;
  for (const s of selected) {
    if (s.codec_type === 'video') args.push(`-disposition:v:${v++}`, 'default');
    if (s.codec_type === 'audio') {
      args.push(`-metadata:s:a:${a}`, 'language=eng', `-disposition:a:${a}`, a === 0 ? 'default' : '0'); a++;
    }
    if (s.codec_type === 'subtitle') {
      args.push(`-metadata:s:s:${sub}`, 'language=eng', `-metadata:s:s:${sub}`, `title=${sdh(s) ? 'English SDH' : 'English'}`, `-disposition:s:${sub}`, '0'); sub++;
    }
  }
  return [...args, '-f', 'matroska', output];
}
function catalogCheck(c: unknown): asserts c is Catalog {
  if (!obj(c) || !text(c.show) || !text(c.reference) || !c.reference.trim() || !Number.isInteger(c.season) || (c.season as number) < 0 || (c.season as number) > 99 || typeof c.seasonFolders !== 'boolean' || !Array.isArray(c.episodes)) fail('Invalid catalog');
  const catalog = c as unknown as Catalog;
  if (catalog.show !== safeName(catalog.show)) fail('Show must be a safe filename');
  const seen = new Set<number>();
  for (const ep of catalog.episodes) {
    if (!obj(ep) || !Number.isInteger(ep.episode) || (ep.episode as number) < 0 || (ep.episode as number) > 99 || !text(ep.title) || !ep.title.trim()) fail('Invalid catalog episode');
    if (seen.has(ep.episode as number)) fail('Duplicate catalog episode');
    seen.add(ep.episode as number); safeName(ep.title as string);
  }
}
function planCheck(v: unknown): asserts v is Plan {
  if (!obj(v) || v.version !== 1 || !text(v.sourceRoot) || !isAbsolute(v.sourceRoot) || !text(v.destinationRoot) || !isAbsolute(v.destinationRoot) || !text(v.createdAt) || !Array.isArray(v.items) || !Array.isArray(v.missing) || !Array.isArray(v.existing) || !Array.isArray(v.ignored)) fail('Invalid plan');
  const plan = v as unknown as Plan;
  catalogCheck(plan.catalog);
  for (const field of ['missing', 'existing', 'ignored'] as const) if (!plan[field].every(text)) fail(`Invalid ${field}`);
  for (const i of plan.items) {
    if (!obj(i) || !text(i.source) || !isAbsolute(i.source) || !text(i.target) || !isAbsolute(i.target) || !text(i.title) || !text(i.sha256) || !shaPattern.test(i.sha256) || !Array.isArray(i.selected) || !i.selected.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0) || !obj(i.probe) || !Array.isArray(i.probe.streams) || !obj(i.probe.format)) fail('Invalid plan item');
    if (!i.probe.streams.every((s: unknown) => obj(s) && Number.isInteger(s.index) && text(s.codec_type) && text(s.codec_name) && ['width', 'height', 'channels'].every(k => !(k in s) || Number.isInteger(s[k])) && (!('tags' in s) || (obj(s.tags) && Object.values(s.tags).every(text))) && (!('disposition' in s) || (obj(s.disposition) && Object.values(s.disposition).every(n => Number.isInteger(n)))))) fail('Invalid probe streams');
    if (i.probe.format.duration !== undefined && !text(i.probe.format.duration)) fail('Invalid duration');
    if (i.probe.format.tags !== undefined && (!obj(i.probe.format.tags) || !Object.values(i.probe.format.tags).every(text))) fail('Invalid format tags');
    if (i.probe.chapters !== undefined && !Array.isArray(i.probe.chapters)) fail('Invalid chapters');
  }
}
export async function loadPlan(path: string): Promise<Plan> { const v: unknown = JSON.parse(await readFile(path, 'utf8')); planCheck(v); planMapping(v); return v; }
async function roots(source: string, dest: string): Promise<[string, string]> {
  const [a, b] = await Promise.all([realpath(source), realpath(dest)]);
  if (!(await stat(a)).isDirectory() || !(await stat(b)).isDirectory() || a === b || within(a, b) || within(b, a)) fail('Source/destination must be disjoint existing directories');
  return [a, b];
}
async function scan(root: string): Promise<{ files: string[]; ignored: string[] }> {
  const files: string[] = [], ignored: string[] = [];
  async function visit(dir: string) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory() && ent.name.startsWith('.video-library-')) ignored.push(path);
      else if (ent.isDirectory()) await visit(path);
      else if (ent.isFile() && videos.has(extname(ent.name).toLowerCase())) files.push(path);
      else ignored.push(path);
    }
  }
  await visit(root); return { files: files.sort(), ignored: ignored.sort() };
}
async function targetSafe(root: string, target: string): Promise<void> {
  await targetSafeAncestors(root, target);
  try { await lstat(target); fail(`Target already exists: ${target}`); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
export async function makePlan(sourceRoot: string, destinationRoot: string, catalog: Catalog, jobs?: number | string): Promise<Plan> {
  const workers = resolveJobs(jobs);
  catalogCheck(catalog);
  const [src, dst] = await roots(sourceRoot, destinationRoot);
  const sources = await scan(src);
  const seasonDir = catalog.seasonFolders ? join(dst, `SEASON ${catalog.season}`) : dst;
  if (catalog.seasonFolders) {
    try { const dir = await lstat(seasonDir); if (!dir.isDirectory() || dir.isSymbolicLink()) fail(`Unsafe season directory: ${seasonDir}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  const existingScan = await scan(seasonDir).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], ignored: [] }; throw e; });
  const known = new Map(catalog.episodes.map(e => [ident(catalog.season, e.episode), e]));
  const existingIds = new Set<string>(), seenExisting = new Set<string>(), sourceIds = new Set<string>(), existing: string[] = [], ignoredDestination: string[] = [], outputNames = new Set<string>();
  const siblingNames = new Map<string, Set<string>>();
  for (const path of existingScan.files) {
    const id = episodeId(basename(path));
    if (!id) throw new Error(`Unknown video in selected season: ${path}`);
    if (!catalog.seasonFolders && Number(id.slice(1, 3)) !== catalog.season) { ignoredDestination.push(path); continue; }
    if (!known.has(id)) throw new Error(`Out-of-catalog video in selected season: ${path}`);
    if (seenExisting.has(id)) fail(`Duplicate existing episode: ${id}`);
    seenExisting.add(id); existingIds.add(id); existing.push(id);
  }
  for (const path of sources.files) {
    const id = episodeId(basename(path));
    if (!id) throw new Error(`Unparseable episode: ${path}`);
    if (!known.has(id)) fail(`Out-of-catalog episode: ${path}`);
    if (sourceIds.has(id) || existingIds.has(id)) fail(`Duplicate/colliding episode: ${id}`);
    sourceIds.add(id);
    const ep = known.get(id)!;
    const title = `${catalog.show} - ${id} - ${safeName(ep.title)}`;
    const target = join(seasonDir, `${title}.mkv`);
    const key = target.toLowerCase();
    if (outputNames.has(key) || [...existingScan.files, ...existingScan.ignored].some(f => f.toLowerCase() === key)) fail(`Case-insensitive target collision: ${target}`);
    let siblings = siblingNames.get(dirname(target));
    if (!siblings) {
      siblings = new Set((await readdir(dirname(target)).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; })).map(name => name.toLowerCase()));
      siblingNames.set(dirname(target), siblings);
    }
    if (siblings.has(basename(target).toLowerCase())) fail(`Case-insensitive target collision: ${target}`);
    outputNames.add(key);
  }
  const items = await runQueue(sources.files, workers, async path => {
    const id = episodeId(basename(path))!;
    const ep = known.get(id)!;
    const title = `${catalog.show} - ${id} - ${safeName(ep.title)}`;
    const target = join(seasonDir, `${title}.mkv`);
    await sourceSafe({ sourceRoot: src } as Plan, { source: path } as Item);
    await targetSafe(dst, target);
    const [p, hash] = await Promise.all([probe(path), sha256(path)]);
    return { source: path, target, title, sha256: hash, probe: p, selected: chooseStreams(p) };
  });
  return { version: 1, sourceRoot: src, destinationRoot: dst, catalog, items, missing: [...known.keys()].filter(id => !sourceIds.has(id) && !existingIds.has(id)), existing: existing.sort(), ignored: [...sources.ignored, ...ignoredDestination], createdAt: new Date().toISOString() };
}
function planMapping(plan: Plan): void {
  const sources = new Set<string>(), targets = new Set<string>();
  for (const item of plan.items) {
    const id = episodeId(basename(item.source));
    const ep = plan.catalog.episodes.find(e => id === ident(plan.catalog.season, e.episode));
    if (!ep) throw new Error(`Unknown episode in plan: ${item.source}`);
    const title = `${plan.catalog.show} - ${id} - ${safeName(ep.title)}`;
    const target = join(plan.destinationRoot, ...(plan.catalog.seasonFolders ? [`SEASON ${plan.catalog.season}`] : []), `${title}.mkv`);
    if (item.title !== title || item.target !== target || JSON.stringify(item.selected) !== JSON.stringify(chooseStreams(item.probe))) fail(`Invalid item mapping: ${item.source}`);
    if (sources.has(item.source) || targets.has(item.target.toLowerCase())) fail('Duplicate plan item');
    sources.add(item.source); targets.add(item.target.toLowerCase());
  }
}
function receiptPath(runDir: string, item: Item) { return join(runDir, `item-${createHash('sha256').update(item.source).digest('hex')}.json`); }
async function receipt(runDir: string, item: Item): Promise<Receipt> {
  const r: unknown = JSON.parse(await readFile(receiptPath(runDir, item), 'utf8'));
  if (!obj(r) || r.source !== item.source || r.target !== item.target || r.sourceSha256 !== item.sha256 || !text(r.outputSha256) || !shaPattern.test(r.outputSha256) || r.fullDecode !== true) fail(`Invalid receipt for ${item.source}`);
  return r as Receipt;
}
async function sourceSafe(plan: Plan, item: Item, allowMissing = false): Promise<boolean> {
  if (!within(plan.sourceRoot, item.source)) fail('Source outside root');
  try {
    const st = await lstat(item.source);
    if (!st.isFile() || st.isSymbolicLink() || !within(plan.sourceRoot, await realpath(item.source))) fail(`Unsafe source: ${item.source}`);
    return true;
  } catch (e) { if (allowMissing && (e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
async function publishedSafe(plan: Plan, item: Item): Promise<void> {
  if (!within(plan.destinationRoot, item.target)) fail('Output outside root');
  const st = await lstat(item.target);
  if (!st.isFile() || st.isSymbolicLink() || !within(plan.destinationRoot, await realpath(item.target))) fail(`Unsafe output: ${item.target}`);
}
async function validateOutput(item: Item, output: string, log: string, decode = true): Promise<void> {
  const got = await probe(output);
  const expected = item.selected.map(i => item.probe.streams.find(s => s.index === i)!);
  const tracks = got.streams.filter(s => ['video', 'audio', 'subtitle'].includes(s.codec_type));
  if (tracks.length !== expected.length || got.streams.length !== expected.length) fail(`Unexpected track count in ${output}`);
  let a = 0, v = 0;
  for (let n = 0; n < expected.length; n++) {
    const x = expected[n], y = tracks[n];
    if (x.codec_type !== y.codec_type || x.codec_name !== y.codec_name || (x.codec_type === 'video' && (x.width !== y.width || x.height !== y.height)) || (x.codec_type === 'audio' && x.channels !== y.channels)) fail(`Track mismatch ${n}: ${output}`);
    if (x.codec_type === 'video' && y.disposition?.default !== (v++ === 0 ? 1 : 0)) fail(`Video disposition mismatch: ${output}`);
    if (x.codec_type === 'audio' && (lang(y) !== 'eng' || y.disposition?.default !== (a++ === 0 ? 1 : 0))) fail(`Audio metadata mismatch: ${output}`);
    if (x.codec_type === 'subtitle' && (lang(y) !== 'eng' || y.tags?.title !== (sdh(x) ? 'English SDH' : 'English') || y.disposition?.default === 1 || y.disposition?.forced === 1)) fail(`Subtitle metadata mismatch: ${output}`);
  }
  if ((got.format.tags?.title ?? got.format.tags?.TITLE) !== item.title) fail(`Title mismatch: ${output}`);
  if ((got.chapters?.length ?? 0) !== (item.probe.chapters?.length ?? 0)) fail(`Chapter count mismatch: ${output}`);
  const before = Number(item.probe.format.duration), after = Number(got.format.duration);
  if (!Number.isFinite(before) || !Number.isFinite(after) || Math.abs(before - after) > 2) fail(`Duration discrepancy ${before}s vs ${after}s: ${output}; review subtitle tails or source`);
  if (decode) await exec(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', output, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], log);
}
async function syncDirectories(start: string, stop: string = sep): Promise<void> {
  let dir = start;
  while (true) {
    const handle = await open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (dir === stop || dir === dirname(dir)) return;
    dir = dirname(dir);
  }
}
async function durableOutput(path: string, root: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectories(dirname(path), root);
}
const digestPlan = (plan: Plan): string => createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (obj(value)) return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if (missing(e)) return false; throw e; }
}
async function atomicRecord(path: string, value: unknown): Promise<void> {
  const temp = join(dirname(path), `.video-library-state-${randomUUID()}`);
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, path);
  await syncDirectories(dirname(path));
}
const checkpointPath = (runDir: string, item: Item) => receiptPath(runDir, item).replace(/\.json$/, '.checkpoint.json');
const itemLog = (runDir: string, item: Item, prefix = 'item') => join(runDir, `${prefix}-${createHash('sha256').update(item.source).digest('hex')}.log`);
async function state(runDir: string, item: Item, digest: string): Promise<{ done?: Receipt; checkpoint?: Checkpoint }> {
  const rp = receiptPath(runDir, item), cp = checkpointPath(runDir, item);
  const done = await exists(rp) ? await receipt(runDir, item) : undefined;
  let checkpoint: Checkpoint | undefined;
  if (await exists(cp)) {
    const raw: unknown = JSON.parse(await readFile(cp, 'utf8'));
    if (!obj(raw) || raw.version !== 1 || raw.planSha256 !== digest || raw.source !== item.source || raw.target !== item.target || raw.sourceSha256 !== item.sha256 || !text(raw.tempDir) || dirname(raw.tempDir) !== dirname(item.target) || !basename(raw.tempDir).startsWith('.video-library-') || !['working', 'validated'].includes(raw.stage as string) || (raw.stage === 'validated' && (raw.fullDecode !== true || !text(raw.outputSha256) || !shaPattern.test(raw.outputSha256))) || (raw.stage === 'working' && (raw.outputSha256 !== undefined || raw.fullDecode !== undefined))) fail(`Invalid checkpoint: ${cp}`);
    checkpoint = raw as Checkpoint;
    if (await exists(checkpoint.tempDir)) {
      const st = await lstat(checkpoint.tempDir);
      if (!st.isDirectory() || st.isSymbolicLink()) fail(`Unsafe checkpoint temp directory: ${checkpoint.tempDir}`);
    }
  }
  if (done && checkpoint && (checkpoint.stage !== 'validated' || done.outputSha256 !== checkpoint.outputSha256)) fail(`Receipt/checkpoint disagreement: ${rp}`);
  return { done, checkpoint };
}
async function manifest(runDir: string, digest: string, required: boolean): Promise<boolean> {
  const path = join(runDir, 'run.json');
  if (!(await exists(path))) {
    if (required) fail('Missing run manifest; cannot verify run ownership');
    return false;
  }
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!obj(raw) || raw.version !== 1 || raw.planSha256 !== digest) fail('Run manifest belongs to another plan');
  return true;
}
async function checkRoots(plan: Plan): Promise<void> {
  planCheck(plan); planMapping(plan);
  const [src, dst] = await roots(plan.sourceRoot, plan.destinationRoot);
  if (src !== plan.sourceRoot || dst !== plan.destinationRoot) fail('Plan roots changed');
}
async function checkedOutput(plan: Plan, item: Item, hash: string, log: string): Promise<void> {
  await publishedSafe(plan, item);
  if (await sha256(item.target) !== hash) fail(`Output hash mismatch: ${item.target}`);
  await validateOutput(item, item.target, log, false);
}
async function validateApplyInputs(plan: Plan, runDir: string, digest: string, jobs: number): Promise<Map<string, { done?: Receipt; checkpoint?: Checkpoint }>> {
  await checkRoots(plan);
  const records = new Map<string, { done?: Receipt; checkpoint?: Checkpoint }>();
  const expectedRecords = new Set(plan.items.flatMap(item => [basename(receiptPath(runDir, item)), basename(checkpointPath(runDir, item))]));
  for (const name of await readdir(runDir)) if (/^item-.*(?:\.checkpoint)?\.json$/.test(name) && !expectedRecords.has(name)) fail(`Unexpected run record: ${name}`);
  for (const item of plan.items) records.set(item.source, await state(runDir, item, digest));
  const sources = await scan(plan.sourceRoot);
  const expectedSources = new Map(plan.items.map(item => [item.source, item]));
  const sourceIds = new Set<string>();
  for (const path of sources.files) {
    const id = episodeId(basename(path));
    if (!id || !expectedSources.has(path) || sourceIds.has(id)) throw new Error(`New, duplicate or unplanned source: ${path}`);
    sourceIds.add(id);
  }
  await runQueue(plan.items, jobs, async item => {
    const present = await sourceSafe(plan, item, true);
    if (!present && !records.get(item.source)?.done) fail(`Missing uncompleted source: ${item.source}`);
    if (present) {
      const [hash, currentProbe] = await Promise.all([sha256(item.source), probe(item.source)]);
      if (hash !== item.sha256 || JSON.stringify(canonical(currentProbe)) !== JSON.stringify(canonical(item.probe)) || JSON.stringify(chooseStreams(currentProbe)) !== JSON.stringify(item.selected)) fail(`Source changed: ${item.source}`);
    }
    const r = records.get(item.source)!;
    if (r.done) await checkedOutput(plan, item, r.done.outputSha256, itemLog(runDir, item));
  });
  const seasonDir = plan.catalog.seasonFolders ? join(plan.destinationRoot, `SEASON ${plan.catalog.season}`) : plan.destinationRoot;
  const destination = await scan(seasonDir).catch(e => { if (missing(e)) return { files: [], ignored: [] }; throw e; });
  const ids = new Set<string>(), existing = new Set<string>(), targets = new Map(plan.items.map(item => [item.target.toLowerCase(), item]));
  const plannedIds = new Set(plan.items.map(item => episodeId(basename(item.target))));
  for (const path of destination.files) {
    const id = episodeId(basename(path));
    if (!id) throw new Error(`Unknown video in selected season: ${path}`);
    if (!plan.catalog.seasonFolders && Number(id.slice(1, 3)) !== plan.catalog.season) continue;
    if (!plan.catalog.episodes.some(ep => id === ident(plan.catalog.season, ep.episode)) || ids.has(id)) fail(`Unknown or duplicate destination episode: ${path}`);
    ids.add(id);
    if (plannedIds.has(id)) {
      const item = targets.get(path.toLowerCase());
      if (!item || item.target !== path || !(records.get(item.source)?.done || records.get(item.source)?.checkpoint?.stage === 'validated')) throw new Error(`Foreign destination collision: ${path}`);
      const r = records.get(item.source)!;
      if (!r.done) await checkedOutput(plan, item, r.checkpoint!.outputSha256!, itemLog(runDir, item));
    } else existing.add(id);
  }
  if (JSON.stringify([...existing].sort()) !== JSON.stringify([...plan.existing].sort()) || JSON.stringify(plan.catalog.episodes.map(ep => ident(plan.catalog.season, ep.episode)).filter(id => !ids.has(id) && !plannedIds.has(id)).sort()) !== JSON.stringify([...plan.missing].sort())) fail('Destination completeness changed');
  const siblings = new Map<string, Set<string>>();
  for (const item of plan.items) {
    await targetSafeAncestors(plan.destinationRoot, item.target);
    let names = siblings.get(dirname(item.target));
    if (!names) { names = new Set((await readdir(dirname(item.target)).catch(e => { if (missing(e)) return []; throw e; })).map(n => n.toLowerCase())); siblings.set(dirname(item.target), names); }
    if (names.has(basename(item.target).toLowerCase()) && !(await exists(item.target))) fail(`Case-insensitive target collision: ${item.target}`);
  }
  return records;
}
async function targetSafeAncestors(root: string, target: string): Promise<void> {
  if (!within(root, target)) fail(`Target escapes destination: ${target}`);
  for (let dir = dirname(target); dir !== root; dir = dirname(dir)) {
    try { const st = await lstat(dir); if (!st.isDirectory() || st.isSymbolicLink()) fail(`Unsafe target ancestor: ${dir}`); }
    catch (e) { if (!missing(e)) throw e; }
  }
}
async function finish(item: Item, plan: Plan, runDir: string, checkpoint: Checkpoint): Promise<void> {
  await checkedOutput(plan, item, checkpoint.outputSha256!, itemLog(runDir, item));
  await durableOutput(item.target, plan.destinationRoot);
  const path = receiptPath(runDir, item);
  if (await exists(path)) await receipt(runDir, item);
  else await atomicRecord(path, { source: item.source, target: item.target, sourceSha256: item.sha256, outputSha256: checkpoint.outputSha256, fullDecode: true });
  if (await exists(checkpoint.tempDir)) await rm(checkpoint.tempDir, { recursive: true });
  await unlink(checkpointPath(runDir, item));
  await syncDirectories(runDir);
}
async function work(item: Item, plan: Plan, runDir: string, digest: string, record: { done?: Receipt; checkpoint?: Checkpoint }, dev: number): Promise<void> {
  if (record.done) {
    console.error(`skip ${basename(item.target)}`);
    if (record.checkpoint) await finish(item, plan, runDir, record.checkpoint);
    return;
  }
  let checkpoint = record.checkpoint;
  const log = itemLog(runDir, item);
  if (checkpoint?.stage === 'working') {
    console.error(`restart ${basename(item.target)}`);
    if (await exists(checkpoint.tempDir)) await rm(checkpoint.tempDir, { recursive: true });
    checkpoint = undefined;
  }
  if (!checkpoint) {
    await mkdir(dirname(item.target), { recursive: true });
    await targetSafe(plan.destinationRoot, item.target);
    const tempDir = await mkdtemp(join(dirname(item.target), '.video-library-'));
    checkpoint = { version: 1, planSha256: digest, source: item.source, target: item.target, sourceSha256: item.sha256, tempDir, stage: 'working' };
    await atomicRecord(checkpointPath(runDir, item), checkpoint);
    const partial = join(tempDir, 'output.partial.mkv');
    console.error(`remux ${basename(item.target)}`);
    await exec(ffmpegArgs(item, partial), log);
    console.error(`decode ${basename(item.target)}`);
    await validateOutput(item, partial, log);
    if (!(await sourceSafe(plan, item)) || await sha256(item.source) !== item.sha256) fail(`Source changed during remux: ${item.source}`);
    const outputSha256 = await sha256(partial);
    await durableOutput(partial, plan.destinationRoot);
    checkpoint = { ...checkpoint, stage: 'validated', outputSha256, fullDecode: true };
    await atomicRecord(checkpointPath(runDir, item), checkpoint);
  } else console.error(`reuse validated ${basename(item.target)}`);
  if (!(await sourceSafe(plan, item)) || await sha256(item.source) !== item.sha256) fail(`Source changed before publication: ${item.source}`);
  if (await realpath(plan.destinationRoot) !== plan.destinationRoot || (await stat(plan.destinationRoot)).dev !== dev) fail('Destination mount/root changed before publication');
  await targetSafeAncestors(plan.destinationRoot, item.target);
  if (!(await exists(item.target))) {
    const partial = join(checkpoint.tempDir, 'output.partial.mkv');
    if (!(await exists(partial))) fail(`Validated partial missing: ${partial}`);
    const st = await lstat(partial);
    if (!st.isFile() || st.isSymbolicLink() || await sha256(partial) !== checkpoint.outputSha256) fail(`Validated partial changed: ${partial}`);
    await validateOutput(item, partial, log, false);
    try { await exec(['mv', '--no-copy', '--update=none-fail', '--no-target-directory', '--', partial, item.target], log); }
    catch (e) { if (!(await exists(item.target)) || await sha256(item.target) !== checkpoint.outputSha256) throw e; }
  }
  await finish(item, plan, runDir, checkpoint);
  console.error(`done ${basename(item.target)}`);
}
export async function applyPlan(plan: Plan, runDir: string, jobs?: number | string, resume = false): Promise<void> {
  const workers = resolveJobs(jobs);
  if (!isAbsolute(runDir)) fail('runDir must be absolute');
  await withRunLock(runDir, async () => {
    const digest = digestPlan(plan);
    const hasManifest = await manifest(runDir, digest, false);
    if (hasManifest && !resume) fail('Run already exists; use --resume');
    if (!hasManifest && (await readdir(runDir)).some(name => /^item-.*(?:\.checkpoint)?\.json$/.test(name))) fail('Missing run manifest with existing records');
    const records = await validateApplyInputs(plan, runDir, digest, workers);
    await exec(['ffmpeg', '-version']); await exec(['ffprobe', '-version']);
    const needsRemux = plan.items.filter(item => !records.get(item.source)?.done && records.get(item.source)?.checkpoint?.stage !== 'validated');
    const required = (await Promise.all(needsRemux.map(async item => (await stat(item.source)).size))).reduce((n, size) => n + size, 0) * 1.1 + 64 * 1024 * 1024;
    const space = await statfs(plan.destinationRoot);
    if (space.bavail * space.bsize < required) fail('Insufficient free destination space');
    if (!hasManifest) await atomicRecord(join(runDir, 'run.json'), { version: 1, planSha256: digest } satisfies RunManifest);
    const dev = (await stat(plan.destinationRoot)).dev;
    await runQueue(plan.items, workers, async (item, index) => {
      console.error(`[${index + 1}/${plan.items.length}] ${basename(item.target)}`);
      await work(item, plan, runDir, digest, records.get(item.source)!, dev);
    });
  });
}
async function verifiedItem(plan: Plan, runDir: string, item: Item, fullDecode: boolean, durable: boolean): Promise<void> {
  const r = await receipt(runDir, item);
  await publishedSafe(plan, item);
  if (await sha256(item.target) !== r.outputSha256) fail(`Output hash mismatch: ${item.target}`);
  if (await sourceSafe(plan, item, true) && await sha256(item.source) !== item.sha256) fail(`Source hash mismatch: ${item.source}`);
  await validateOutput(item, item.target, itemLog(runDir, item, 'verify'), fullDecode);
  if (durable) await durableOutput(item.target, plan.destinationRoot);
}
export async function verifyPlan(plan: Plan, runDir: string, fullDecode = false, jobs?: number | string): Promise<void> {
  const workers = resolveJobs(jobs);
  await withRunLock(runDir, async () => {
    await checkRoots(plan);
    await manifest(runDir, digestPlan(plan), true);
    await runQueue(plan.items, workers, item => verifiedItem(plan, runDir, item, fullDecode, false));
  });
}
export async function cleanupSources(plan: Plan, runDir: string, jobs?: number | string): Promise<void> {
  const workers = resolveJobs(jobs);
  await withRunLock(runDir, async () => {
    await checkRoots(plan);
    await manifest(runDir, digestPlan(plan), true);
    // Complete queued preflight before any source is removed.
    await runQueue(plan.items, workers, item => verifiedItem(plan, runDir, item, false, true));
    await syncDirectories(await realpath(runDir));
    await runQueue(plan.items, workers, async item => {
      if (await sourceSafe(plan, item, true)) {
        if (await sha256(item.source) !== item.sha256) fail(`Source changed before removal: ${item.source}`);
        await unlink(item.source);
      }
    });
  });
}
