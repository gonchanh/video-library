#!/usr/bin/env bun
/** Isolated, loopback-only integration against an installed Jellyfin binary. */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { metadataPath, renderNfo } from './jellyfin';
import { digestPlan, loadPlan, sha256, type MovieCatalog, type TvCatalog } from './media';
import { parseJellyfinMetadata, type JellyfinMetadata } from './structured';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const exec = (args: string[], timeout = 30000) => {
  const result = Bun.spawnSync(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr.toString().slice(-1200)}`);
  return result.stdout.toString();
};
async function freePort(): Promise<number> {
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); assert(address && typeof address !== 'string', 'No free port'); const port = address.port; server.close(() => resolve(port)); });
  });
}
function checkBinding(pid: number, port: number): boolean {
  if (process.platform === 'win32') {
    assert(Bun.which('powershell.exe'), 'PowerShell required for Windows listener verification');
    assert(Number.isSafeInteger(pid) && pid > 0, 'Invalid server PID');
    const script = `@(Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort) | ConvertTo-Json -Compress`;
    const raw = exec(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]).trim();
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const listeners: unknown[] = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    for (const entry of listeners) {
      assert(entry !== null && typeof entry === 'object' && 'LocalAddress' in entry && 'LocalPort' in entry, 'Unverifiable Windows listener');
      assert(entry.LocalAddress === '127.0.0.1' || entry.LocalAddress === '::1', `Non-loopback listener detected: ${String(entry.LocalAddress)}`);
    }
    return listeners.some(entry => entry !== null && typeof entry === 'object' && 'LocalAddress' in entry && 'LocalPort' in entry && entry.LocalAddress === '127.0.0.1' && entry.LocalPort === port);
  }
  if (process.platform !== 'linux' || !Bun.which('ss')) throw new Error('Listener verification requires Linux ss or Windows PowerShell; refusing to contact server');
  const lines = exec(['ss', '-H', '-ltnp']).split('\n').filter(line => line.includes(`pid=${pid},`));
  for (const line of lines) {
    const addr = line.trim().split(/\s+/)[3];
    assert(/^127\.0\.0\.1:\d+$/.test(addr) || /^\[::1\]:\d+$/.test(addr), `Non-loopback listener detected: ${addr}`);
  }
  return lines.some(line => line.trim().split(/\s+/)[3] === `127.0.0.1:${port}`);
}
function fixture(kind: 'movie' | 'episode', title: string, year: number | null, id: number, number?: number) {
  return parseJellyfinMetadata(JSON.stringify({ kind, title, reference: 'https://example.org/fixture', provider: 'user', year, plot: `Distinct synthetic plot ${id}`, genres: [`FixtureGenre${id}`], studios: [], directors: [], actors: [{ name: `Fixture Actor ${id}`, role: `Role ${id}` }], imdbId: `tt${String(id).padStart(7, '0')}`, tmdbId: id, season: number === undefined ? null : 1, episode: number ?? null, aired: null, showTitle: kind === 'episode' ? 'Fixture Show' : null }));
}
function cli(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, '--no-env-file', fileURLToPath(new URL('./video-library.ts', import.meta.url)), ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 120000 });
  assert(result.exitCode === 0, `CLI ${args[0]} failed: ${(result.stderr.toString() + result.stdout.toString()).slice(-1200)}`);
  return result.stdout.toString();
}
type ApiItem = { Id: string; Name: string; ProductionYear?: number; Overview?: string; Genres?: string[]; People?: { Name: string; Role: string }[]; ProviderIds?: Record<string, string>; ParentIndexNumber?: number; IndexNumber?: number };
/** A name appearing in /Items does not mean metadata/people have finished importing. */
export function metadataMismatch(actual: ApiItem, expected: JellyfinMetadata): string | null {
  if (actual.Name !== expected.title) return `${expected.title}: title mismatch`;
  if (actual.ProductionYear !== expected.year) return `${expected.title}: year mismatch`;
  if (actual.Overview !== expected.plot) return `${expected.title}: plot mismatch`;
  if (!actual.Genres?.includes(expected.genres[0])) return `${expected.title}: genre mismatch`;
  if (!actual.People?.some(person => person.Name === expected.actors[0].name && person.Role === expected.actors[0].role)) return `${expected.title}: actor role mismatch; actual People=${JSON.stringify(actual.People)}`;
  if (actual.ProviderIds?.Imdb !== expected.imdbId || String(actual.ProviderIds?.Tmdb) !== String(expected.tmdbId)) return `${expected.title}: provider IDs mismatch ${JSON.stringify(actual.ProviderIds)}`;
  if (expected.kind === 'episode' && (actual.ParentIndexNumber !== 1 || actual.IndexNumber !== 2)) return `Episode numbers mismatch: ${actual.ParentIndexNumber}/${actual.IndexNumber}`;
  return null;
}
async function clip(path: string) {
  exec(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', '-shortest', '-y', path]);
}
export async function runJellyfinE2E(): Promise<void> {
  const bin = process.env.JELLYFIN_BIN ?? Bun.which(process.platform === 'win32' ? 'jellyfin.exe' : 'jellyfin');
  assert(bin, 'Jellyfin binary unavailable (set JELLYFIN_BIN)');
  const versionResult = Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
  const version = (versionResult.stdout.toString() + versionResult.stderr.toString()).trim();
  assert(/Jellyfin\.Server \d+\.\d+/.test(version), `Cannot identify Jellyfin binary: ${version}`);
  assert(Bun.which('ffmpeg') && (process.platform === 'win32' ? Bun.which('powershell.exe') : Bun.which('ss')), 'ffmpeg and a listener inspection tool (Linux ss or Windows PowerShell) are required');
  const root = await mkdtemp(join(tmpdir(), 'video-library-jellyfin-e2e-'));
  const log = join(root, 'server-output.log');
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let success = false;
  try {
    for (const dir of ['data', 'config', 'cache', 'logs', 'movies', 'shows', 'incomingMovies', 'incomingTv', 'plans', 'home']) await mkdir(join(root, dir));
    const port = await freePort();
    await writeFile(join(root, 'config', 'network.xml'), `<?xml version="1.0" encoding="utf-8"?><NetworkConfiguration><InternalHttpPort>${port}</InternalHttpPort><PublicHttpPort>${port}</PublicHttpPort><EnableIPV4>true</EnableIPV4><EnableIPV6>false</EnableIPV6><EnableRemoteAccess>false</EnableRemoteAccess><EnableUPnP>false</EnableUPnP><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses></NetworkConfiguration>`);
    const movies = [fixture('movie', 'Copper Lantern', 2003, 991001), fixture('movie', 'Silver Teapot', 2011, 991002)];
    const episode = fixture('episode', 'The Quiet Clock', 2019, 991003, 2);
    const reference = 'https://example.org/fixture';
    const movieFiles = ['Fixture Movie 1.mp4', 'Fixture Movie 2.mp4'];
    const tvFile = 'Fixture Show - S01E02.mp4';
    for (const file of movieFiles) await clip(join(root, 'incomingMovies', file));
    await clip(join(root, 'incomingTv', tvFile));
    const sourcePaths = [...movieFiles.map(file => join(root, 'incomingMovies', file)), join(root, 'incomingTv', tvFile)];
    const originalHashes = await Promise.all(sourcePaths.map(sha256));
    const movieCatalog: MovieCatalog = { kind: 'movies', reference, movies: movies.map((movie, i) => ({ file: movieFiles[i], title: movie.title, year: movie.year!, reference })) };
    const tvCatalog: TvCatalog = { kind: 'tv', show: 'Fixture Show', season: 1, reference, episodes: [{ episode: 2, title: episode.title }], seasonFolders: true };
    const showRoot = join(root, 'shows', 'Fixture Show'); await mkdir(showRoot);
    async function publish(label: string, source: string, destination: string, catalog: MovieCatalog | TvCatalog, metadata: Record<string, unknown>, count: number) {
      const artifact = join(root, 'plans');
      const planPath = join(artifact, `${label}.json`);
      const catalogPath = join(artifact, `${label}-catalog.json`);
      const metadataMapPath = join(artifact, `${label}-metadata.json`);
      const runPath = join(artifact, `${label}-run`);
      await writeFile(catalogPath, JSON.stringify(catalog));
      await writeFile(metadataMapPath, JSON.stringify(metadata));
      const report = cli('plan', '--source', source, '--destination', destination, '--catalog', catalogPath, '--metadata', metadataMapPath, '--out', planPath, '--jobs', '1');
      const plan = await loadPlan(planPath);
      assert(plan.items.length === count && plan.items.every(item => item.metadata), `${label}: plan missing metadata`);
      const digest = digestPlan(plan);
      assert(report.includes(digest), `${label}: approved digest absent from planning report`);
      cli('apply', '--plan', planPath, '--run', runPath, '--execute', '--approved-sha256', digest, '--jobs', '1');
      cli('verify', '--plan', planPath, '--run', runPath, '--full-decode', '--jobs', '1');
      for (const item of plan.items) {
        const nfo = await readFile(metadataPath(item), 'utf8');
        assert(nfo === renderNfo(item.metadata!), `${label}: published NFO differs from approved plan`);
      }
      return plan;
    }
    const moviePlan = await publish('movies', join(root, 'incomingMovies'), join(root, 'movies'), movieCatalog, Object.fromEntries(movieFiles.map((file, i) => [file, movies[i]])), 2);
    assert((await readdir(join(root, 'movies'))).filter(name => name.endsWith('.mp4')).length === 2 && moviePlan.items.every(item => dirname(item.target) === join(root, 'movies')), 'Movie outputs are not flat');
    const tvPlan = await publish('tv', join(root, 'incomingTv'), showRoot, tvCatalog, { [tvFile]: episode }, 1);
    assert(dirname(tvPlan.items[0].target) === join(showRoot, 'SEASON 1'), 'Episode not published to season directory');
    for (let i = 0; i < sourcePaths.length; i++) assert(await sha256(sourcePaths[i]) === originalHashes[i], `Source changed: ${sourcePaths[i]}`);
    const home = join(root, 'home'), cache = join(root, 'cache');
    const env = { PATH: process.env.PATH ?? '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? '', WINDIR: process.env.WINDIR ?? '', USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: cache, TMP: cache } : {}), HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: cache, TMPDIR: cache, LANG: 'C.UTF-8' };
    server = Bun.spawn([bin, '--datadir', join(root, 'data'), '--configdir', join(root, 'config'), '--cachedir', join(root, 'cache'), '--logdir', join(root, 'logs'), '--nowebclient', '--nonetchange'], { env, stdin: 'ignore', stdout: Bun.file(log), stderr: Bun.file(log) });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Jellyfin exited ${server.exitCode}`);
      if (checkBinding(server.pid, port)) break;
      await Bun.sleep(400);
    }
    assert(checkBinding(server.pid, port), 'Jellyfin never bound expected loopback port');
    const password = randomBytes(24).toString('hex');
    let token = '';
    async function request<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: token ? `MediaBrowser Token="${token}"` : 'MediaBrowser Client="fixture", Device="fixture", DeviceId="fixture-local", Version="1"' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status} ${text.slice(0, 600)}`);
      return (text ? JSON.parse(text) : null) as T;
    }
    while (true) {
      assert(Date.now() < deadline, 'Jellyfin startup did not become ready');
      if (!checkBinding(server.pid, port)) { await Bun.sleep(500); continue; }
      try { await request('/Startup/User'); break; }
      catch (error) { if (!(error instanceof Error) || !error.message.includes('HTTP 503')) throw error; await Bun.sleep(500); }
    }
    assert(checkBinding(server.pid, port), 'Jellyfin lost loopback-only listener');
    await request('/Startup/User', 'POST', { Name: 'fixture-admin', Password: password });
    await request('/Startup/RemoteAccess', 'POST', { EnableRemoteAccess: false });
    await request('/Startup/Complete', 'POST');
    const auth = await request<{ AccessToken?: string }>('/Users/AuthenticateByName', 'POST', { Username: 'fixture-admin', Pw: password });
    assert(auth?.AccessToken, 'Missing auth token'); token = auth.AccessToken;
    for (const [name, type, path] of [['FixtureMovies', 'movies', join(root, 'movies')], ['FixtureShows', 'tvshows', join(root, 'shows')]]) {
      const query = new URLSearchParams({ name, collectionType: type, paths: path, refreshLibrary: 'false' });
      await request(`/Library/VirtualFolders?${query}`, 'POST', { LibraryOptions: { EnableInternetProviders: false, MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [], ImageFetcherOrder: [], SeasonMetadataFetchers: [], EpisodeMetadataFetchers: [], MovieMetadataFetchers: [] } });
    }
    const folders = await request<{ Name: string; LibraryOptions?: { EnableInternetProviders?: boolean } }[]>('/Library/VirtualFolders');
    for (const name of ['FixtureMovies', 'FixtureShows']) {
      const options = folders.find(folder => folder.Name === name)?.LibraryOptions;
      assert(options?.EnableInternetProviders === false, `${name}: internet providers not confirmed disabled: ${JSON.stringify(options)}`);
    }
    await request('/Library/Refresh', 'POST');
    const scanDeadline = Date.now() + 90000;
    let mismatch = 'Items not listed yet';
    while (Date.now() < scanDeadline) {
      const items = (await request<{ Items: ApiItem[] }>('/Items?Recursive=true&Fields=Path,ProviderIds,People,Genres,Overview&IncludeItemTypes=Movie,Episode'))?.Items ?? [];
      mismatch = '';
      for (const expected of [...movies, episode]) {
        const found = items.filter(item => item.Name === expected.title);
        assert(found.length <= 1, `Duplicate item: ${expected.title}`);
        if (!found.length) { mismatch = `${expected.title}: not listed yet`; break; }
        const actual = await request<ApiItem>(`/Items/${found[0].Id}?Fields=Path,ProviderIds,People,Genres,Overview`);
        mismatch = metadataMismatch(actual, expected) ?? '';
        if (mismatch) break;
      }
      if (!mismatch) break;
      await Bun.sleep(500);
    }
    assert(!mismatch, `Metadata import not complete before deadline: ${mismatch}`);
    success = true;
    console.log(`Jellyfin E2E passed (${version}): CLI plan/apply/verify published two flat movies and one episode; filename.nfo imported on loopback`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; isolated logs: ${log}`, { cause: error });
  } finally {
    if (server) { server.kill('SIGKILL'); await server.exited; }
    if (success) await rm(root, { recursive: true, force: true });
  }
}
if (import.meta.main) runJellyfinE2E().catch(error => { console.error(error.message); process.exitCode = 1; });
