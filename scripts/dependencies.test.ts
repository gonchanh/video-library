import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const checker = fileURLToPath(new URL("./check-dependencies.ts", import.meta.url));

function runChecker(path = process.env.PATH ?? "") {
  return Bun.spawnSync([process.execPath, checker], {
    env: { ...process.env, PATH: path },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000,
  });
}

test("external dependencies are installed and runnable", () => {
  const result = runChecker();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  for (const name of ["ffmpeg", "ffprobe", "nice", "flock", "mv"]) expect(result.stdout.toString()).toContain(`${name}:`);
});

test("missing external dependencies fail with installation guidance", async () => {
  const empty = await mkdtemp(join(tmpdir(), "video-library-empty-path-"));
  try {
    const result = runChecker(empty);
    expect(result.exitCode).toBe(1);
    const error = result.stderr.toString();
    for (const name of ["ffmpeg", "ffprobe", "nice", "flock", "mv"]) expect(error).toContain(`${name}: executable missing from PATH`);
    expect(error).toContain("coreutils");
    expect(error).toContain("util-linux");
    expect(error).toContain("bun install only installs package.json dependencies");
  } finally { await rm(empty, { recursive: true, force: true }); }
});

test("installed but broken executables report their runtime failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "video-library-broken-tool-"));
  try {
    await writeFile(join(dir, "ffmpeg"), '#!/bin/sh\nprintf "%s\\n" "error while loading shared libraries: libavcodec.so: cannot open shared object file" >&2\nexit 127\n', { mode: 0o755 });
    const result = runChecker(`${dir}${delimiter}${process.env.PATH ?? ""}`);
    expect(result.exitCode).toBe(1);
    const error = result.stderr.toString();
    expect(error).toContain(`ffmpeg: installed at ${join(dir, "ffmpeg")}, but failed to run`);
    expect(error).toContain("libavcodec.so");
    expect(error).not.toContain("ffmpeg: executable missing");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
