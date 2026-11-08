import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRunLock } from "./run-lock";

async function inTempDir(testBody: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "video-library-lock-"));
  try { await testBody(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("requires an absolute run directory", async () => {
  await expect(withRunLock("relative", async () => {})).rejects.toThrow("absolute");
});

test("contends while the first action is pending and releases after success", async () => {
  await inTempDir(async dir => {
    const runDir = join(dir, "new", "run");
    const entered = deferred();
    const release = deferred();
    const first = withRunLock(runDir, async () => {
      entered.resolve();
      await release.promise;
      return 42;
    });
    try {
      await entered.promise;
      await expect(withRunLock(runDir, async () => "wrong")).rejects.toThrow("Run is locked by another process");
    } finally {
      release.resolve();
    }
    expect(await first).toBe(42);
    expect((await stat(join(runDir, "apply.lock"))).isFile()).toBe(true);
    expect(await withRunLock(runDir, async () => "reacquired")).toBe("reacquired");
  });
});

test("releases on action failure without removing the lock file", async () => {
  await inTempDir(async dir => {
    await expect(withRunLock(dir, async () => { throw new Error("action failed"); })).rejects.toThrow("action failed");
    expect((await stat(join(dir, "apply.lock"))).isFile()).toBe(true);
    expect(await withRunLock(dir, async () => 7)).toBe(7);
  });
});

test("refuses a symlink in place of the lock file", async () => {
  await inTempDir(async dir => {
    const target = join(dir, "target");
    await writeFile(target, "unchanged");
    await symlink(target, join(dir, "apply.lock"));
    await expect(withRunLock(dir, async () => {})).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("unchanged");
  });
});

test("a killed lock-holding process releases its lock without stale reclamation", async () => {
  await inTempDir(async dir => {
    const moduleUrl = new URL("./run-lock.ts", import.meta.url).href;
    const script = `import { withRunLock } from ${JSON.stringify(moduleUrl)}; await withRunLock(${JSON.stringify(dir)}, async () => { console.log("READY"); await Bun.stdin.text(); });`;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      while (!output.includes("READY\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`Lock holder exited before READY: ${await new Response(child.stderr).text()}`);
        output += decoder.decode(value, { stream: true });
      }
      reader.releaseLock();
      await expect(withRunLock(dir, async () => {})).rejects.toThrow("Run is locked by another process");
      child.kill("SIGKILL");
      await child.exited;
      expect((await stat(join(dir, "apply.lock"))).isFile()).toBe(true);
      expect(await withRunLock(dir, async () => "acquired")).toBe("acquired");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });
});
