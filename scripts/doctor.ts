#!/usr/bin/env bun

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tools = [
  { name: "ffmpeg", args: ["-version"] },
  { name: "ffprobe", args: ["-version"] },
  { name: "jellyfin", args: ["--version"] },
  ...(process.platform === 'win32'
    ? [{ name: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'] }]
    : [
      { name: "nice", args: ["-n", "0", process.execPath, "--version"] },
      { name: "flock", args: ["--version"] },
      { name: "mv", args: ["--version"] },
      { name: "ss", args: ["-V"] },
    ]),
];

/** Check real executables, including startup failures from missing shared libraries. */
export function checkExternalDependencies(): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = [];
  const errors: string[] = [];
  for (const tool of tools) {
    const path = Bun.which(tool.name === "jellyfin" ? process.env.JELLYFIN_BIN ?? tool.name : tool.name);
    if (!path) {
      errors.push(`${tool.name}: executable missing from PATH`);
      continue;
    }
    try {
      const result = Bun.spawnSync([path, ...tool.args], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      // Jellyfin's version parser exits 1 even after printing a valid version.
      const jellyfinVersion = tool.name === "jellyfin" && result.exitCode === 1 && /^\s*Jellyfin\.Server \d+\.\d+\.\d+(?:\.\d+)?\s*$/.test(result.stdout.toString() + result.stderr.toString());
      if ((result.exitCode !== 0 && !jellyfinVersion) || result.signalCode) {
        const detail = (result.stderr.toString() || result.stdout.toString()).trim().slice(-1500);
        errors.push(`${tool.name}: installed at ${path}, but failed to run (exit ${result.exitCode}${result.signalCode ? `, signal ${result.signalCode}` : ""})${detail ? `: ${detail}` : ""}`);
      } else found.push({ name: tool.name, path });
    } catch (error) {
      errors.push(`${tool.name}: installed at ${path}, but failed to run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) {
    const guidance = process.platform === 'win32'
      ? 'Install FFmpeg/FFprobe for Windows (e.g. winget install Gyan.FFmpeg) and ensure ffmpeg.exe and ffprobe.exe are on PATH; Windows PowerShell 5.1 (powershell.exe) is required for native locks and publication. Install Jellyfin Server and add jellyfin.exe to PATH or set JELLYFIN_BIN. Repair any installed tool that fails to launch.'
      : 'Install FFmpeg/FFprobe (Fedora: sudo dnf install ffmpeg-free; Debian/Ubuntu: sudo apt install ffmpeg), GNU coreutils for nice/mv, util-linux for flock, iproute2 for ss, and Jellyfin Server for isolated metadata verification; repair runtime libraries if an installed tool cannot start.';
    throw new Error(`External dependency check failed:\n${errors.map(e => `- ${e}`).join("\n")}\n${guidance} bun install only installs package.json dependencies.`);
  }
  return found;
}

async function run(label: string, args: string[], executable = process.execPath): Promise<boolean> {
  console.log(`\n${label}: ${executable} ${args.join(" ")}`);
  try {
    const child = Bun.spawn([executable, ...args], {
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

  const binary = process.platform === "win32" ? "baml.exe" : "baml";
  const fallback = join(homedir(), ".baml", "bin", binary);
  const baml = Bun.which(binary) ?? (await Bun.file(fallback).exists() ? fallback : undefined);
  if (!baml) {
    console.error("BAML CLI missing. Install the toolchain using https://boundaryml.com/quickstart, then rerun bun run doctor.");
    return false;
  }
  if (!await run("Generate local BAML schemas", ["generate"], baml)) return false;
  const health = Bun.spawnSync([process.execPath, join(root, "scripts", "tmdb.ts"), "check-api"], {
    cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  try {
    const status: unknown = JSON.parse(health.stdout.toString());
    if (health.exitCode !== 0 || !status || typeof status !== "object" || !("message" in status) || typeof status.message !== "string") throw new Error("Unavailable");
    console.log(status.message);
  } catch {
    console.warn("TMDB access could not be verified. Use IMDb as the default movie reference. Metadata can be wrong or incomplete; review identity before approval.");
  }

  // Different test files have separate workers; individual media tests keep their sequential fixture setup.
  const results = await Promise.all([
    run("Lint", ["run", "--no-env-file", "lint"]),
    run("Typecheck", ["--no-env-file", "check", "--no-script"]),
    run("Tests", ["test", "--parallel=2", "--dots", "--no-env-file"]),
  ]);
  if (results.some(ok => !ok)) {
    console.error("Doctor failed. Fix the reported checks and retry bun run doctor.");
    return false;
  }
  if (!await run("Jellyfin end-to-end verification", ["--no-env-file", "scripts/jellyfin-e2e.ts"])) return false;
  console.log("Doctor passed. Next: gather movie references or the complete season episode-list reference, inventory files, and prepare reviewed metadata. Approve the verified generated plan before changing media. Run bun scripts/video-library.ts --help for commands.");
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
