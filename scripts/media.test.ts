import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, copyFile, rm, readdir, appendFile, symlink, stat as fileStat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkExternalDependencies } from "./doctor";
import { applyPlan, digestPlan, chooseStreams, cleanupSources, episodeId, ffmpegArgs, makePlan, probe, safeName, sha256, verifyPlan, type Catalog, type Plan, type Probe } from "./media";

const streamProbe: Probe = {
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
    { index: 1, codec_type: "audio", codec_name: "eac3", channels: 6, tags: { language: "eng" } },
    { index: 2, codec_type: "audio", codec_name: "eac3", tags: { language: "ger" } },
    { index: 3, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng", title: "English" } },
    { index: 4, codec_type: "subtitle", codec_name: "subrip", tags: { language: "en", title: "English SDH" } },
    { index: 5, codec_type: "subtitle", codec_name: "subrip", tags: { language: "ger" } },
  ], format: { duration: "10" }, chapters: [],
};

describe("selection and naming", () => {
  test("matches one episode and rejects combined episodes", () => {
    expect(episodeId("Show.S01E04.1080p.mkv")).toBe("S01E04");
    expect(episodeId("Show - S09E10 - Finale.mkv")).toBe("S09E10");
    expect(episodeId("readme.txt")).toBeNull();
    for (const file of ["S01E01E02.mkv", "S01E01-E02.mkv", "S01E01.S01E02.mkv", "S01E01-02.mkv", "S01E01_02.mkv"]) expect(() => episodeId(file)).toThrow();
  });
  test("sanitizes titles and selects only English streams", () => {
    expect(safeName('A: B/C?*. ')).not.toMatch(/[<>:"/\\|?*]/);
    expect(() => safeName("... ")).toThrow();
    expect(chooseStreams(streamProbe)).toEqual([0, 1, 3, 4]);
  });
  test("unknown-language tracks require a decision", () => {
    const p = structuredClone(streamProbe);
    p.streams[1].tags = {};
    expect(() => chooseStreams(p)).toThrow();
  });
  test("refuses ASS/SSA subtitles with font attachments that cannot be copied safely", () => {
    for (const [codec, mimetype] of [["ass", "font/ttf"], ["ssa", "application/x-truetype-font"]]) {
      const p = structuredClone(streamProbe);
      p.streams[3].codec_name = codec;
      p.streams.push({ index: 6, codec_type: "attachment", codec_name: "ttf", tags: { mimetype } });
      expect(() => chooseStreams(p)).toThrow();
    }
  });
  test("refuses multiple unidentified English subtitles rather than guessing SDH", () => {
    const p = structuredClone(streamProbe);
    p.streams[3].tags = { language: "eng" };
    p.streams[4].tags = { language: "eng", title: " " };
    expect(() => chooseStreams(p)).toThrow();
  });
  test("builds lossless commands with explicit mappings", () => {
    const args = ffmpegArgs({ source: "/input with spaces.mkv", target: "/out.mkv", title: "Show - S01E01 - Pilot", sha256: "a".repeat(64), probe: streamProbe, selected: [0, 1, 3, 4] }, "/partial.mkv");
    expect(args[0]).toBe("ffmpeg");
    expect(args).toContain("-n");
    expect(args).toContain("copy");
    expect(args).toContain("0:3");
    expect(args).not.toContain("0:5");
    expect(args).toContain("title=English SDH");
    expect(args).not.toContain("libx265");
  });
});

let temp: string;
let fixture: string;
const catalog: Catalog = { show: "Test Show", season: 1, reference: "https://example.org/episodes", seasonFolders: false, episodes: [{ episode: 1, title: "Pilot" }, { episode: 2, title: "Second" }] };

beforeAll(async () => {
  checkExternalDependencies();
  temp = await mkdtemp(join(tmpdir(), "video-library-test-"));
  fixture = join(temp, "fixture.mkv");
  const sub = join(temp, "English.srt");
  await writeFile(sub, "1\n00:00:00,000 --> 00:00:00,700\nHello\n");
  const chapters = join(temp, "chapters.ffmeta");
  await writeFile(chapters, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=700\ntitle=Intro\n");
  const result = Bun.spawnSync([
    "ffmpeg", "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-i", sub, "-f", "ffmetadata", "-i", chapters,
    "-map", "0:v", "-map", "1:a", "-map", "2:s", "-map", "2:s", "-map", "2:s", "-map_chapters", "3",
    "-c:v", "mpeg4", "-c:a", "aac", "-c:s", "srt",
    "-metadata:s:a:0", "language=eng", "-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=English",
    "-metadata:s:s:1", "language=eng", "-metadata:s:s:1", "title=English SDH",
    "-metadata:s:s:2", "language=ger", "-metadata", "comment=release advertising", fixture,
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
});
afterAll(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

async function setup() {
  const base = await mkdtemp(join(temp, "case-"));
  const source = join(base, "incoming"); const dest = join(base, "library"); const run = join(base, "receipts");
  await mkdir(source); await mkdir(dest);
  const input = join(source, "Test.Show.S01E01.mkv");
  await copyFile(fixture, input);
  return { base, source, dest, run, input };
}

describe("real FFmpeg workflow", () => {
  test("plans completeness across source and existing library", async () => {
    const { source, dest } = await setup();
    await copyFile(fixture, join(dest, "Test Show - S01E02 - Second.mkv"));
    const plan = await makePlan(source, dest, catalog);
    expect(plan.missing).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.existing).toHaveLength(1);
    expect(plan.items[0].target).toEndWith("Test Show - S01E01 - Pilot.mkv");
  });
  test("ignores different seasons in a flat destination", async () => {
    const { source, dest } = await setup();
    await copyFile(fixture, join(dest, "Other Show - S02E01 - Pilot.mkv"));
    const plan = await makePlan(source, dest, catalog);
    expect(plan.items).toHaveLength(1);
    expect(plan.existing).toEqual([]);
    expect(plan.missing).toEqual(["S01E02"]);
  });
  test("reports missing and ignores nonvideo sidecars", async () => {
    const { source, dest } = await setup();
    await writeFile(join(source, "notes.nfo"), "keep me");
    const plan = await makePlan(source, dest, catalog);
    expect(plan.missing).toEqual(["S01E02"]);
    expect(plan.ignored.some(p => p.endsWith("notes.nfo"))).toBe(true);
  });
  test("stops duplicates, unknown videos and nested destinations", async () => {
    const { source, dest } = await setup();
    await copyFile(fixture, join(source, "Alternative.S01E01.mkv"));
    await expect(makePlan(source, dest, catalog)).rejects.toThrow();
    await rm(join(source, "Alternative.S01E01.mkv"));
    await copyFile(fixture, join(source, "mystery.mkv"));
    await expect(makePlan(source, dest, catalog)).rejects.toThrow();
    await rm(join(source, "mystery.mkv"));
    const nested = join(source, "clean"); await mkdir(nested);
    await expect(makePlan(source, nested, catalog)).rejects.toThrow();
  });
  test("refuses an existing destination episode", async () => {
    const { source, dest } = await setup();
    await copyFile(fixture, join(dest, "Old.S01E01.mkv"));
    await expect(makePlan(source, dest, catalog)).rejects.toThrow();
  });
  test("blocks changed sources and edited plan streams before publication", async () => {
    const { source, dest, run, input } = await setup();
    const plan = await makePlan(source, dest, catalog);
    plan.items[0].selected = [0, 1, 4];
    await expect(applyPlan(plan, run)).rejects.toThrow();
    const fresh = await makePlan(source, dest, catalog);
    await appendFile(input, "changed");
    await expect(applyPlan(fresh, run)).rejects.toThrow();
    expect((await readdir(dest)).filter(n => n.endsWith(".mkv"))).toEqual([]);
  }, 60000);
  test("remuxes, verifies, retains originals, then cleans only approved sources", async () => {
    const { source, dest, run, input } = await setup();
    const sidecar = join(source, "notes.nfo"); await writeFile(sidecar, "keep");
    const plan = await makePlan(source, dest, catalog);
    const originalHash = await sha256(input);
    expect(plan.items[0].probe.chapters).toHaveLength(1);
    await applyPlan(plan, run, 1);
    expect(await sha256(input)).toBe(originalHash);
    const out = await probe(plan.items[0].target);
    expect(out.streams.map(s => s.codec_type)).toEqual(["video", "audio", "subtitle", "subtitle"]);
    expect(out.streams[0].codec_name).toBe("mpeg4");
    expect(out.chapters).toHaveLength(1);
    expect(out.streams[1].disposition?.default).toBe(1);
    expect(out.streams.slice(2).every(s => s.disposition?.default === 0 && s.disposition?.forced === 0)).toBe(true);
    expect(out.format.tags?.title).toBe("Test Show - S01E01 - Pilot");
    expect(out.format.tags?.COMMENT ?? out.format.tags?.comment).toBeUndefined();
    await verifyPlan(plan, run);
    await expect(cleanupSources(plan, run)).rejects.toThrow("user confirmation");
    const saved = await savePlan(join(run, ".."), plan);
    const unconfirmed = Bun.spawnSync([process.execPath, cliPath, "cleanup", "--plan", saved, "--run", run, "--delete-sources"], { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    expect(unconfirmed.exitCode).not.toBe(0);
    expect(unconfirmed.stderr.toString()).toContain("--confirm-transfer");
    expect(await Bun.file(input).exists()).toBe(true);
    await cleanupSources(plan, run, undefined, true);
    expect(await Bun.file(input).exists()).toBe(false);
    expect(await Bun.file(sidecar).text()).toBe("keep");
    expect(await Bun.file(plan.items[0].target).exists()).toBe(true);
    await cleanupSources(plan, run, undefined, true);
  }, 60000);
  test("corrupted output blocks cleanup without deleting source", async () => {
    const { source, dest, run, input } = await setup();
    const plan = await makePlan(source, dest, catalog);
    await applyPlan(plan, run, 1);
    await appendFile(plan.items[0].target, "corrupted");
    await expect(verifyPlan(plan, run)).rejects.toThrow();
    await expect(cleanupSources(plan, run, undefined, true)).rejects.toThrow();
    expect(await Bun.file(input).exists()).toBe(true);
  }, 60000);
  test("verification rejects missing or false full-decode receipts", async () => {
    const { source, dest, run, input } = await setup();
    const plan = await makePlan(source, dest, catalog);
    await applyPlan(plan, run, 1);
    const receipt = join(run, (await readdir(run)).find(p => /^item-[a-f0-9]{64}\.json$/.test(p))!);
    const record = await Bun.file(receipt).json();
    await writeFile(receipt, JSON.stringify({ ...record, fullDecode: false }));
    await expect(verifyPlan(plan, run)).rejects.toThrow();
    await expect(cleanupSources(plan, run, undefined, true)).rejects.toThrow();
    expect(await Bun.file(input).exists()).toBe(true);
    await rm(receipt);
    await expect(verifyPlan(plan, run)).rejects.toThrow();
  }, 60000);
  test("fresh full-decode verification runs only when requested", async () => {
    const { source, dest, run } = await setup();
    const plan = await makePlan(source, dest, catalog);
    await applyPlan(plan, run, 1);
    await verifyPlan(plan, run);
    expect((await readdir(run)).some(p => p.startsWith("verify-"))).toBe(false);
    await verifyPlan(plan, run, true);
    const log = (await readdir(run)).find(p => p.startsWith("verify-") && p.endsWith(".log"));
    expect(log).toBeDefined();
    expect(await Bun.file(join(run, log!)).text()).toContain('"nice" "-n" "15" "ffmpeg"');
  }, 60000);
  test("preflights every receipt before deleting any source", async () => {
    const { source, dest, run, input } = await setup();
    const second = join(source, "Test.Show.S01E02.mkv");
    await copyFile(fixture, second);
    const plan = await makePlan(source, dest, catalog);
    expect(plan.items).toHaveLength(2);
    await applyPlan(plan, run, 1);
    await appendFile(plan.items[1].target, "corrupted");
    await expect(cleanupSources(plan, run, undefined, true)).rejects.toThrow();
    expect(await Bun.file(input).exists()).toBe(true);
    expect(await Bun.file(second).exists()).toBe(true);
  }, 60000);
  test("only verified plans produce the generated approval report", async () => {
    const { base, source, dest, input } = await setup();
    const path = join(base, "catalog.json"), out = join(base, "approved.json");
    await writeFile(path, JSON.stringify(catalog));
    const args = [process.execPath, cliPath, "plan", "--source", source, "--destination", dest, "--catalog", path, "--out", out];
    const planned = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    expect(planned.exitCode, planned.stderr.toString()).toBe(0);
    const review = await Bun.file(join(base, "approved.md")).text();
    expect(review).toBe(planned.stdout.toString().trimEnd() + "\n");
    expect(review).toContain("# Verified transfer plan");
    expect(review).toContain("WARNING: missing episodes S01E02");
    expect(review).toContain("Originals stay in place");
    expect(await Bun.file(input).exists()).toBe(true);
    expect(await readdir(dest)).toHaveLength(0);
    await writeFile(path, JSON.stringify({ ...catalog, reference: "" }));
    const rejected = Bun.spawnSync([...args.slice(0, -1), join(base, "invalid.json")], { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stdout.toString()).toBe("");
    expect(await Bun.file(join(base, "invalid.json")).exists()).toBe(false);
    await writeFile(path, JSON.stringify(catalog));
    const collisionOut = join(base, "collision.json"), oldReport = join(base, "collision.md");
    await writeFile(oldReport, "previous approval");
    const collided = Bun.spawnSync([...args.slice(0, -1), collisionOut], { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    expect(collided.exitCode).not.toBe(0);
    expect(collided.stdout.toString()).toBe("");
    expect(await Bun.file(collisionOut).exists()).toBe(false);
    expect(await Bun.file(oldReport).text()).toBe("previous approval");
  }, 60000);

  test("first execution rejects a plan changed after approval", async () => {
    const { base, source, dest, run, input } = await setup();
    const approved = await makePlan(source, dest, catalog, 1);
    const changed = await makePlan(source, dest, { ...catalog, episodes: [{ episode: 1, title: "Changed" }, catalog.episodes[1]] }, 1);
    const path = await savePlan(base, changed);
    const rejected = Bun.spawnSync([
      process.execPath, cliPath, "apply", "--plan", path, "--run", run, "--execute", "--allow-missing", "--approved-sha256", digestPlan(approved),
    ], { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain("human-approved report");
    expect(await Bun.file(join(run, "apply.lock")).exists()).toBe(false);
    expect(await sha256(input)).toBe(approved.items[0].sha256);
    expect(await readdir(dest)).toHaveLength(0);
  }, 60000);

  test("destination symlinks cannot redirect publication", async () => {
    const { base, source, dest, run } = await setup();
    const c = { ...catalog, seasonFolders: true };
    const plan = await makePlan(source, dest, c);
    const elsewhere = join(base, "elsewhere"); await mkdir(elsewhere);
    await symlink(elsewhere, join(dest, "SEASON 1"));
    await expect(applyPlan(plan, run, 1)).rejects.toThrow();
    expect(await readdir(elsewhere)).toEqual([]);
  }, 60000);
});

const cliPath = fileURLToPath(new URL("./video-library.ts", import.meta.url));
const receiptNames = async (run: string) => (await readdir(run)).filter(name => /^item-[a-f0-9]{64}\.json$/.test(name));
const checkpointNames = async (run: string) => (await readdir(run)).filter(name => name.endsWith(".checkpoint.json"));

async function savePlan(base: string, plan: Plan) {
  const path = join(base, "plan.json");
  await writeFile(path, JSON.stringify(plan));
  return path;
}

function applyCLI(plan: string, run: string, resume = false, path = process.env.PATH ?? "") {
  return Bun.spawnSync([
    process.execPath, cliPath, "apply", "--plan", plan, "--run", run,
    "--execute", "--approved-sha256", digestPlan(JSON.parse(readFileSync(plan, "utf8"))), "--allow-missing", "--jobs", "1", ...(resume ? ["--resume"] : []),
  ], { env: { ...process.env, PATH: path }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60000 });
}

function avPacketHashes(path: string) {
  const result = Bun.spawnSync([
    "ffmpeg", "-nostdin", "-v", "error", "-i", path, "-map", "0:v", "-map", "0:a",
    "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-",
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function toolShim(base: string, tool: string, body: string) {
  const bin = join(base, "test-tools");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, tool), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

async function interruptedPublish() {
  const ctx = await setup();
  const plan = await makePlan(ctx.source, ctx.dest, catalog);
  const path = await savePlan(ctx.base, plan);
  const shim = await toolShim(ctx.base, "mv", 'printf "%s\\n" "simulated publication interruption" >&2\nexit 42');
  const failed = applyCLI(path, ctx.run, false, shim);
  expect(failed.exitCode).not.toBe(0);
  const checkpointPath = join(ctx.run, (await checkpointNames(ctx.run))[0]);
  const checkpointText = await Bun.file(checkpointPath).text();
  const checkpoint = JSON.parse(checkpointText);
  expect(checkpoint.stage).toBe("validated");
  expect(checkpoint.fullDecode).toBe(true);
  return { ...ctx, plan, path, checkpointPath, checkpointText, checkpoint };
}

describe("resume and interruption integrity", () => {
  test("completed outputs are verified and skipped, not overwritten", async () => {
    const { source, dest, run, input } = await setup();
    const plan = await makePlan(source, dest, catalog);
    await applyPlan(plan, run, 2);
    const target = plan.items[0].target;
    const before = await fileStat(target);
    const hash = await sha256(target);
    await expect(applyPlan(plan, run, 2)).rejects.toThrow("--resume");
    await applyPlan(plan, run, 2, true);
    expect((await fileStat(target)).mtimeMs).toBe(before.mtimeMs);
    expect(await sha256(target)).toBe(hash);
    expect(await sha256(input)).toBe(plan.items[0].sha256);
    expect(await receiptNames(run)).toHaveLength(1);
    expect(await checkpointNames(run)).toHaveLength(0);
  }, 60000);

  test("a partially completed two-file run resumes only its unfinished item", async () => {
    const { base, source, dest, run, input } = await setup();
    await copyFile(fixture, join(source, "Test.Show.S01E02.mkv"));
    const plan = await makePlan(source, dest, catalog);
    const path = await savePlan(base, plan);
    const mv = JSON.stringify(Bun.which("mv")!);
    const shim = await toolShim(base, "mv", `case "$*" in *S01E02*) exit 42;; esac\nexec ${mv} "$@"`);
    expect(applyCLI(path, run, false, shim).exitCode).not.toBe(0);
    expect(await receiptNames(run)).toHaveLength(1);
    const firstStat = await fileStat(plan.items[0].target);
    const resumed = applyCLI(path, run, true);
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(resumed.stderr.toString()).toContain("skip ");
    expect(resumed.stderr.toString()).toContain("reuse validated");
    expect((await fileStat(plan.items[0].target)).mtimeMs).toBe(firstStat.mtimeMs);
    expect(await receiptNames(run)).toHaveLength(2);
    expect(await checkpointNames(run)).toHaveLength(0);
    expect(await sha256(input)).toBe(plan.items[0].sha256);
    await verifyPlan(plan, run, true, 2);
    for (const item of plan.items) expect(avPacketHashes(item.target)).toBe(avPacketHashes(item.source));
  }, 60000);

  for (const stage of ["remux", "decode"] as const) {
    test(`SIGKILL during ${stage} leaves source intact; resume restarts untrusted partial`, async () => {
      const { base, source, dest, run, input } = await setup();
      const plan = await makePlan(source, dest, catalog);
      const path = await savePlan(base, plan);
      const ffmpeg = JSON.stringify(Bun.which("ffmpeg")!);
      const match = stage === "remux" ? '*"-c copy"*' : '*"-f null -"*';
      const truncate = stage === "remux" ? 'for last do :; done\nprintf "incomplete output" > "$last"\n' : "";
      // The shim's parent is only the isolated CLI subprocess, never this test runner.
      const shim = await toolShim(base, "ffmpeg", `case "$*" in ${match})\n${truncate}kill -KILL "$PPID"\nexit 0;;\nesac\nexec ${ffmpeg} "$@"`);
      expect(applyCLI(path, run, false, shim).exitCode).not.toBe(0);
      const checkpoint = await Bun.file(join(run, (await checkpointNames(run))[0])).json();
      expect(checkpoint.stage).toBe("working");
      expect(await Bun.file(plan.items[0].target).exists()).toBe(false);
      expect(await sha256(input)).toBe(plan.items[0].sha256);
      const resumed = applyCLI(path, run, true);
      expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
      expect(resumed.stderr.toString()).toContain("restart ");
      await verifyPlan(plan, run, true, 1);
      expect(avPacketHashes(plan.items[0].target)).toBe(avPacketHashes(input));
      expect(await sha256(input)).toBe(plan.items[0].sha256);
    }, 60000);
  }

  test("SIGKILL after atomic publication recovers receipt without another remux", async () => {
    const { base, source, dest, run, input } = await setup();
    const plan = await makePlan(source, dest, catalog);
    const path = await savePlan(base, plan);
    const mv = JSON.stringify(Bun.which("mv")!);
    const shim = await toolShim(base, "mv", `${mv} "$@" || exit $?\nkill -KILL "$PPID"\nexit 0`);
    expect(applyCLI(path, run, false, shim).exitCode).not.toBe(0);
    expect(await receiptNames(run)).toHaveLength(0);
    const checkpoint = await Bun.file(join(run, (await checkpointNames(run))[0])).json();
    expect(checkpoint.stage).toBe("validated");
    expect(await sha256(plan.items[0].target)).toBe(checkpoint.outputSha256);
    const before = await fileStat(plan.items[0].target);
    const resumed = applyCLI(path, run, true);
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(resumed.stderr.toString()).not.toContain("remux ");
    expect((await fileStat(plan.items[0].target)).mtimeMs).toBe(before.mtimeMs);
    expect(await receiptNames(run)).toHaveLength(1);
    await verifyPlan(plan, run, true, 1);
    expect(avPacketHashes(plan.items[0].target)).toBe(avPacketHashes(input));
    expect(await sha256(input)).toBe(plan.items[0].sha256);
  }, 60000);

  test("resume rejects a corrupt validated partial and keeps original", async () => {
    const { path, run, input, plan, checkpoint } = await interruptedPublish();
    await appendFile(join(checkpoint.tempDir, "output.partial.mkv"), "corrupted");
    const resumed = applyCLI(path, run, true);
    expect(resumed.exitCode).not.toBe(0);
    expect(resumed.stderr.toString()).toContain("Validated partial changed");
    expect(await Bun.file(plan.items[0].target).exists()).toBe(false);
    expect(await sha256(input)).toBe(plan.items[0].sha256);
  }, 60000);

  test("resume never overwrites an unrelated final-path collision", async () => {
    const { path, run, input, plan } = await interruptedPublish();
    const target = plan.items[0].target;
    await writeFile(target, "unrelated file");
    const resumed = applyCLI(path, run, true);
    expect(resumed.exitCode).not.toBe(0);
    expect(await Bun.file(target).text()).toBe("unrelated file");
    expect(await sha256(input)).toBe(plan.items[0].sha256);
    expect(await receiptNames(run)).toHaveLength(0);
  }, 60000);

  test("resume rejects changed plan, completed output, and source without repairing them silently", async () => {
    const { source, dest, run, input } = await setup();
    const plan = await makePlan(source, dest, catalog);
    await applyPlan(plan, run, 1);
    await expect(applyPlan({ ...plan, createdAt: "changed" }, run, 1, true)).rejects.toThrow("another plan");
    await appendFile(plan.items[0].target, "corrupted");
    const damaged = await sha256(plan.items[0].target);
    await expect(applyPlan(plan, run, 1, true)).rejects.toThrow("Output hash mismatch");
    expect(await sha256(plan.items[0].target)).toBe(damaged);
    expect(await sha256(input)).toBe(plan.items[0].sha256);
    const other = await setup();
    const otherPlan = await makePlan(other.source, other.dest, catalog);
    await applyPlan(otherPlan, other.run, 1);
    await appendFile(other.input, "changed source");
    const changed = await sha256(other.input);
    await expect(applyPlan(otherPlan, other.run, 1, true)).rejects.toThrow("Source changed");
    expect(await sha256(other.input)).toBe(changed);
  }, 60000);

  test("missing run manifest cannot weaken the original batch deletion preflight", async () => {
    const { source, dest, run, input } = await setup();
    const second = join(source, "Test.Show.S01E02.mkv");
    await copyFile(fixture, second);
    const plan = await makePlan(source, dest, catalog);
    await applyPlan(plan, run, 2);
    await appendFile(plan.items[1].target, "corrupted");
    await rm(join(run, "run.json"));
    const shortened = { ...plan, items: [plan.items[0]] };
    await expect(verifyPlan(shortened, run)).rejects.toThrow("Missing run manifest");
    await expect(cleanupSources(shortened, run, undefined, true)).rejects.toThrow("Missing run manifest");
    expect(await sha256(input)).toBe(plan.items[0].sha256);
    expect(await sha256(second)).toBe(plan.items[1].sha256);
  }, 60000);

  test("resume clears a checkpoint left after durable receipt creation", async () => {
    const ctx = await interruptedPublish();
    const resumed = applyCLI(ctx.path, ctx.run, true);
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    await writeFile(ctx.checkpointPath, ctx.checkpointText);
    await applyPlan(ctx.plan, ctx.run, 1, true);
    expect(await checkpointNames(ctx.run)).toHaveLength(0);
    expect(await receiptNames(ctx.run)).toHaveLength(1);
    expect(await sha256(ctx.input)).toBe(ctx.plan.items[0].sha256);
  }, 60000);
});
