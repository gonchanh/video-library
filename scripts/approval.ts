import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { extname, relative } from "node:path";
import { containerProfile } from "./containers";
import { digestPlan, effectiveProbe, type Plan, type Stream } from "./media";

export type ApprovalPlan = {
  version: 1;
  planPath: string;
  planSha256: string;
  generatedInMs: number;
  source: string;
  destination: string;
  reference: string;
  jobs: number;
  requiredFreeBytes: number;
  availableFreeBytes: number;
  missing: string[];
  existing: string[];
  ignored: string[];
  languageOverrides: string[];
  outputs: { source: string; destination: string; kept: string[]; dropped: string[]; containerNotes: string }[];
};

function track(stream: Stream): string {
  return `#${stream.index} ${stream.codec_type} ${stream.codec_name}${stream.tags?.language ? ` ${stream.tags.language}` : ""}${stream.tags?.title ? ` ${stream.tags.title}` : ""}`;
}

export function approvalPlan(plan: Plan, details: Pick<ApprovalPlan, "planPath" | "requiredFreeBytes" | "availableFreeBytes" | "generatedInMs">): ApprovalPlan {
  return {
    version: 1, ...details, jobs: plan.jobs, planSha256: digestPlan(plan),
    source: plan.sourceRoot, destination: plan.destinationRoot,
    reference: plan.catalog.reference, missing: plan.missing, existing: plan.existing, ignored: plan.ignored,
    languageOverrides: Object.entries(plan.catalog.languageOverrides ?? {}).flatMap(([file, streams]) => Object.entries(streams).map(([index, language]) => `${file}: #${index} assigned ${language}`)),
    outputs: plan.items.map(item => ({
      source: relative(plan.sourceRoot, item.source),
      destination: relative(plan.destinationRoot, item.target),
      containerNotes: containerProfile(extname(item.target)).limitations,
      kept: effectiveProbe(plan, item).streams.filter(stream => item.selected.includes(stream.index)).map(track),
      dropped: effectiveProbe(plan, item).streams.filter(stream => !item.selected.includes(stream.index)).map(track),
    })),
  };
}

const cell = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_[\]{}|~]/g, "\\$&").replace(/[\r\n]/g, " ");
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

export function renderApproval(plan: ApprovalPlan): string {
  return [
    "# Verified transfer plan", "",
    `Plan: ${cell(plan.planPath)}`,
    `Plan SHA-256: ${plan.planSha256}`,
    `Generated and checked in ${(plan.generatedInMs / 1000).toFixed(2)} seconds.`, "",
    `Source: ${cell(plan.source)}`,
    `Destination: ${cell(plan.destination)}`,
    `Episode reference: ${cell(plan.reference)}`, "",
    "Operation: lossless video cleanup. Originals stay in place.",
    "Preserve each source container and extension unless a requested conversion is shown in the destination mapping.",
    "Keep selected English tracks and all chapters. Reset descriptive metadata where supported. Format-specific limits are listed below.",
    `Parallel files: ${plan.jobs}. FFmpeg uses native multithreading.`,
    `Destination space: ${gib(plan.requiredFreeBytes)} required; ${gib(plan.availableFreeBytes)} available.`, "",
    ...(plan.missing.length ? [`WARNING: missing episodes ${plan.missing.join(", ")}. Approval explicitly accepts these gaps.`, ""] : ["Missing episodes: none.", ""]),
    `Already present: ${plan.existing.join(", ") || "none"}.`,
    `Unchanged sidecars or exclusions: ${plan.ignored.length}.`, "",
    "| Source | Destination | Kept tracks | Dropped tracks |",
    "| --- | --- | --- | --- |",
    ...plan.outputs.map(item => `| ${cell(item.source)} | ${cell(item.destination)} | ${cell(item.kept.join("; "))} | ${cell(item.dropped.join("; ") || "none")} |`), "",
    ...(plan.languageOverrides.length ? ["## Explicit language corrections", "", ...plan.languageOverrides.map(mapping => `- ${cell(mapping)}`), ""] : []),
    "## Container limits", "", ...[...new Set(plan.outputs.map(item => item.containerNotes))].map(note => `- ${cell(note)}`), "",
    ...(plan.ignored.length ? ["## Unchanged files", "", ...plan.ignored.map(path => `- ${cell(path)}`), ""] : []),
    "## Verification and approval", "",
    "Each output must pass track checks, a full audio/video decode, SHA-256 verification and durable publication. Collisions or changed files stop the run without deleting originals.",
    "Approve this exact plan to run the transfer unattended. After verification, check the transferred files yourself. Source deletion requires a separate confirmation of successful transfer.", "",
  ].join("\n");
}

export async function publishApproval(path: string, plan: Plan, report: string): Promise<void> {
  const paths = [path, path.replace(/\.json$/i, "") + ".md"];
  const owned: { path: string; handle: FileHandle; dev: number; ino: number }[] = [];
  try {
    for (const target of paths) {
      const handle = await open(target, "wx", 0o600);
      const identity = await handle.stat();
      owned.push({ path: target, handle, dev: identity.dev, ino: identity.ino });
    }
    await owned[0].handle.writeFile(JSON.stringify(plan, null, 2) + "\n");
    await owned[1].handle.writeFile(report);
    await Promise.all(owned.map(entry => entry.handle.sync()));
  } catch (error) {
    for (const entry of owned) {
      const current = await lstat(entry.path).catch(cause => {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        return undefined;
      });
      if (current?.dev === entry.dev && current.ino === entry.ino) await unlink(entry.path);
    }
    throw error;
  } finally {
    await Promise.all(owned.map(entry => entry.handle.close()));
  }
}
