#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readdir, realpath, mkdir, stat } from "node:fs/promises";
import { resolve, join, extname, dirname } from "node:path";
import { applyPlan, cleanupSources, loadPlan, makePlan, probe, verifyPlan, type Catalog } from "./media";
import { resolveJobs, runQueue } from "./queue";

const help = `Video library: lossless episodic MKV cleanup
Run from this skill directory. Requires Bun, ffmpeg, ffprobe, GNU nice/mv and util-linux flock.

bun scripts/video-library.ts inventory --source /path/to/videos
bun scripts/video-library.ts plan --source /incoming --destination /library/show --catalog /run/catalog.json --out /run/plan.json
bun scripts/video-library.ts apply --plan /run/plan.json --run /run/receipts --execute [--jobs auto] [--allow-missing] [--resume]
bun scripts/video-library.ts verify --plan /run/plan.json --run /run/receipts [--full-decode]
bun scripts/video-library.ts cleanup --plan /run/plan.json --run /run/receipts --delete-sources

Catalog JSON, one show and season per input folder:
{
  "show": "Example Show",
  "season": 1,
  "reference": "https://example.org/episodes",
  "seasonFolders": true,
  "episodes": [{"episode": 1, "title": "Pilot"}]
}
Include EVERY expected episode for that season, not only incoming files.
Source and destination must already exist and must not contain one another.
Plan stops for unknown-language tracks, duplicates, unmatched IDs and collisions.
Apply keeps originals. Cleanup deletes only verified planned sources.
--jobs auto|N applies to every command. Default auto uses the maximum.
Maximum jobs = max(4, floor(physical cores / 2)); explicit N can only lower it.
FFmpeg runs at nice 15 with native multithreading.
Verify checks hashes and structure against prior full-decode receipts.
Use --full-decode only when a fresh full decode is wanted.
Resume with the SAME --plan and --run, adding --execute --resume.
Completed outputs are hash-checked and skipped; interrupted files restart or reuse validated partials.
Runs use a kernel-held lock; persistent apply.lock is not a stale lock. Never unlink it.
`;

async function inventory(root: string, jobs: number): Promise<void> {
  root = await realpath(root);
  const entries: { path: string; video: boolean }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".video-library-")) await walk(path);
      else entries.push({ path, video: entry.isFile() && /\.(mkv|mp4|avi|m4v|mov|webm|ts)$/i.test(extname(path)) });
    }
  };
  await walk(root);
  const records = await runQueue(entries, jobs, async entry => entry.video
    ? { path: entry.path, probe: await probe(entry.path) }
    : { ignored: entry.path });
  for (const record of records) console.log(JSON.stringify(record));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2), allowPositionals: true, strict: true,
    options: {
      source: { type: "string" }, destination: { type: "string" }, catalog: { type: "string" },
      out: { type: "string" }, plan: { type: "string" }, run: { type: "string" },
      jobs: { type: "string" }, execute: { type: "boolean" }, resume: { type: "boolean" },
      "allow-missing": { type: "boolean" }, "delete-sources": { type: "boolean" }, "full-decode": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  if (positionals.length !== 1) throw new Error("Expected exactly one command. Use --help.");
  const required = (name: "source" | "destination" | "catalog" | "out" | "plan" | "run") => {
    const value = values[name];
    if (!value) throw new Error(`Missing --${name}`);
    return resolve(value);
  };
  const command = positionals[0];
  const jobs = resolveJobs(values.jobs);
  if (values.resume && command !== "apply") throw new Error("--resume is only supported by apply");
  if (command === "inventory") { await inventory(required("source"), jobs); return; }
  if (command === "plan") {
    const catalog: Catalog = await Bun.file(required("catalog")).json();
    const plan = await makePlan(required("source"), required("destination"), catalog, jobs);
    const out = required("out");
    await mkdir(dirname(out), { recursive: true });
    // Exclusive creation prevents replacing the manifest of an existing run.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    const sizes = await runQueue(plan.items, jobs, async item => (await stat(item.source)).size);
    const requiredFreeBytes = Math.ceil(sizes.reduce((sum, size) => sum + size, 0) * 1.1 + 64 * 1024 * 1024);
    console.log(JSON.stringify({ plan: out, requiredFreeBytes, outputs: plan.items.map(i => ({ source: i.source, target: i.target, tracks: i.selected })), missing: plan.missing, existing: plan.existing, ignored: plan.ignored }, null, 2));
    return;
  }
  if (!["apply", "verify", "cleanup"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const plan = await loadPlan(required("plan"));
  const run = required("run");
  if (command === "apply") {
    if (!values.execute) throw new Error("Review the plan, then pass --execute to publish files.");
    if (plan.missing.length && !values["allow-missing"]) throw new Error(`Missing episodes: ${plan.missing.join(", ")}. Get approval, then pass --allow-missing.`);
    await applyPlan(plan, run, jobs, values.resume ?? false);
  } else if (command === "verify") await verifyPlan(plan, run, values["full-decode"] ?? false, jobs);
  else {
    if (!values["delete-sources"]) throw new Error("Source deletion requires an approved move and --delete-sources.");
    await cleanupSources(plan, run, jobs);
  }
  console.log(`${command} complete`);
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
