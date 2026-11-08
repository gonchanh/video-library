#!/usr/bin/env bun

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
      if (result.exitCode !== 0) {
        const detail = (result.stderr.toString() || result.stdout.toString()).trim().slice(-1500);
        errors.push(`${tool.name}: installed at ${path}, but failed to run (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
      } else found.push({ name: tool.name, path });
    } catch (error) {
      errors.push(`${tool.name}: installed at ${path}, but failed to run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) {
    throw new Error(`External dependency check failed:\n${errors.map(e => `- ${e}`).join("\n")}\nInstall FFmpeg/FFprobe, GNU coreutils for nice/mv, and util-linux for flock, or repair their runtime libraries. bun install only installs package.json dependencies.`);
  }
  return found;
}

if (import.meta.main) {
  try {
    for (const tool of checkExternalDependencies()) console.log(`${tool.name}: ${tool.path}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
