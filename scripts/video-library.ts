#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readdir, realpath, mkdir } from "node:fs/promises";
import { resolve, join, extname, dirname } from "node:path";
import { applyPlan, approvedJobs, cleanupSources, digestPlan, loadPlan, makePlan, probe, spaceBudget, verifyPlan, type Catalog } from "./media";
import { approvalPlan, publishApproval, renderApproval } from "./approval";
import { attachMetadata } from "./metadata-plan";
import { parseApprovalPlan } from "./structured";
import { videoExtensions } from "./containers";
import { resolveJobs, runQueue } from "./queue";

const help = `Video library: lossless video cleanup
Run from this skill directory after bun run doctor.
Linux uses GNU nice/mv and util-linux flock; Windows uses PowerShell 5.1.

bun scripts/video-library.ts inventory --source /path/to/videos
bun scripts/video-library.ts plan --source /incoming --destination /library/show --catalog /run/catalog.json --out /run/plan.json [--metadata /run/metadata-map.json]
bun scripts/video-library.ts apply --plan /run/plan.json --run /run/receipts --execute --approved-sha256 SHA_FROM_REPORT [--jobs N] [--allow-missing] [--resume]
bun scripts/video-library.ts verify --plan /run/plan.json --run /run/receipts [--full-decode]
bun scripts/video-library.ts cleanup --plan /run/plan.json --run /run/receipts --delete-sources --confirm-transfer

Catalog JSON, one show and season per input folder:
{
  "show": "Example Show",
  "season": 1,
  "reference": "https://example.org/episodes",
  "seasonFolders": true,
  "episodes": [{"episode": 1, "title": "Pilot"}]
}
Include EVERY expected episode for that season, not only incoming files.
Movies use a separate flat destination, e.g. /library/Movies, and this catalog:
{"kind":"movies","reference":"https://www.imdb.com/","movies":[{"file":"The.Matrix.1999.mp4","title":"The Matrix","year":1999,"reference":"https://www.imdb.com/title/tt0133093/"}]}
Movie output: Matrix, The - 1999.mp4. No per-movie folders.
Optional metadata map: source-relative filename -> BAML-validated Jellyfin metadata.
Prepare TMDB metadata with bun scripts/tmdb.ts --help before planning.
Without API access use IMDb as the default movie reference; metadata can be wrong or incomplete.
Catalog languageOverrides maps source-relative filenames and stream indices to human-confirmed languages.
Source and destination must already exist and must not contain one another.
Plan stops for unknown-language tracks, duplicates, unmatched IDs and collisions.
Plan writes checked JSON plus a matching human-readable .md approval report.
Preserve each input container by default; catalog.container changes it only on explicit request.
Apply keeps originals. Cleanup requires the user's later confirmation of successful transfer.
--jobs auto|N sets plan concurrency, defaulting to the maximum.
Execution defaults to the approved limit; --jobs can only lower it.
Maximum jobs = max(4, floor(physical cores / 2)); explicit N can only lower it.
FFmpeg uses native multithreading, at nice 15 on Linux.
Windows support is machine-untested; automatic source cleanup is disabled.
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
      else entries.push({ path, video: entry.isFile() && videoExtensions.has(extname(path).toLowerCase()) });
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
      out: { type: "string" }, plan: { type: "string" }, run: { type: "string" }, metadata: { type: "string" },
      jobs: { type: "string" }, "approved-sha256": { type: "string" }, execute: { type: "boolean" }, resume: { type: "boolean" },
      "allow-missing": { type: "boolean" }, "delete-sources": { type: "boolean" }, "confirm-transfer": { type: "boolean" }, "full-decode": { type: "boolean" },
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
    const out = required("out");
    if (!/\.json$/i.test(out)) throw new Error("--out must name a new .json planning artifact outside media folders");
    const started = performance.now();
    const catalog: Catalog = await Bun.file(required("catalog")).json();
    const draft = await makePlan(required("source"), required("destination"), catalog, jobs);
    const plan = await attachMetadata(draft, values.metadata ? await Bun.file(resolve(values.metadata)).json() : {});
    const budget = await spaceBudget(plan.items, plan.destinationRoot, jobs);
    const review = renderApproval(parseApprovalPlan(JSON.stringify(approvalPlan(plan, { planPath: out, ...budget, generatedInMs: Math.round(performance.now() - started) }))));
    await mkdir(dirname(out), { recursive: true });
    await publishApproval(out, plan, review);
    console.log(review);
    return;
  }
  if (!["apply", "verify", "cleanup"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const plan = await loadPlan(required("plan"));
  const run = required("run");
  const executionJobs = approvedJobs(plan, values.jobs);
  if (command === "apply") {
    if (values["approved-sha256"] !== digestPlan(plan)) throw new Error("Pass --approved-sha256 from the human-approved report; the current plan must match exactly.");
    if (!values.execute) throw new Error("Review the plan, then pass --execute to publish files.");
    if (plan.missing.length && !values["allow-missing"]) throw new Error(`Missing episodes: ${plan.missing.join(", ")}. Get approval, then pass --allow-missing.`);
    await applyPlan(plan, run, executionJobs, values.resume ?? false);
  } else if (command === "verify") await verifyPlan(plan, run, values["full-decode"] ?? false, executionJobs);
  else {
    if (!values["delete-sources"] || !values["confirm-transfer"]) throw new Error("Source deletion requires the user's confirmation of successful transfer, --delete-sources and --confirm-transfer.");
    await cleanupSources(plan, run, executionJobs, true);
  }
  console.log(`${command} complete`);
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
