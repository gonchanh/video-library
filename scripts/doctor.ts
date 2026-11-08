#!/usr/bin/env bun

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tools = [
  { name: "ffmpeg", args: ["-version"] },
  { name: "ffprobe", args: ["-version"] },
  { name: "nice", args: ["-n", "0", process.execPath, "--version"] },
  { name: "flock", args: ["--version"] },
  { name: "mv", args: ["--version"] },
];

/** Check real executables, including startup failures from missing shared libraries. */
export function checkExternalDependencies(): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = [];
  const errors: string[] = [];
  for (const tool of tools) {
    const path = Bun.which(tool.name);
    if (!path) {
      errors.push(`${tool.name}: executable missing from PATH`);
      continue;
    }
    try {
      const result = Bun.spawnSync([path, ...tool.args], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      if (result.exitCode !== 0 || result.signalCode) {
        const detail = (result.stderr.toString() || result.stdout.toString()).trim().slice(-1500);
        errors.push(`${tool.name}: installed at ${path}, but failed to run (exit ${result.exitCode}${result.signalCode ? `, signal ${result.signalCode}` : ""})${detail ? `: ${detail}` : ""}`);
      } else found.push({ name: tool.name, path });
    } catch (error) {
      errors.push(`${tool.name}: installed at ${path}, but failed to run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) {
    throw new Error(`External dependency check failed:\n${errors.map(e => `- ${e}`).join("\n")}\nInstall FFmpeg/FFprobe (Fedora: sudo dnf install ffmpeg-free; Debian/Ubuntu: sudo apt install ffmpeg), GNU coreutils for nice/mv, and util-linux for flock; repair runtime libraries if an installed tool cannot start. bun install only installs package.json dependencies.`);
  }
  return found;
}

async function run(label: string, args: string[]): Promise<boolean> {
  console.log(`\n${label}: bun ${args.join(" ")}`);
  try {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode === 0 && child.signalCode === null) return true;
    console.error(`${label} failed (exit ${exitCode}${child.signalCode ? `, signal ${child.signalCode}` : ""}).`);
  } catch (error) {
    console.error(`${label} could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  return false;
}

export async function doctor(): Promise<boolean> {
  // Install first so a clean checkout needs only Bun; then refresh versions within package.json ranges.
  if (!await run("Install dependencies", ["install", "--no-env-file", "--ignore-scripts"])) {
    console.error("Check network/registry access and package.json, then retry bun run doctor.");
    return false;
  }
  if (!await run("Update dependencies", ["update", "--no-env-file", "--ignore-scripts"])) {
    console.error("Check network/registry access and dependency version constraints, then retry bun run doctor.");
    return false;
  }
  try {
    for (const tool of checkExternalDependencies()) console.log(`${tool.name}: ${tool.path}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return false;
  }

  // Different test files have separate workers; individual media tests keep their sequential fixture setup.
  const results = await Promise.all([
    run("Lint", ["run", "--no-env-file", "lint"]),
    run("Typecheck", ["--no-env-file", "check", "--no-script"]),
    run("Tests", ["test", "--parallel=2", "--no-env-file"]),
  ]);
  if (results.some(ok => !ok)) {
    console.error("Doctor failed. Fix the reported checks and retry bun run doctor.");
    return false;
  }
  console.log("Doctor passed. Next: gather an episode-list reference and inventory the library; review and approve a verified plan before changing media. Run bun scripts/video-library.ts --help for commands.");
  return true;
}

if (import.meta.main) {
  try {
    if (!await doctor()) process.exitCode = 1;
  } catch (error) {
    console.error(`Doctor failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
