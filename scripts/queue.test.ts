import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { physicalCoreCount, maxJobs, resolveJobs, runQueue } from "./queue";

describe("resolveJobs", () => {
  test("defaults to half the physical cores with a floor of four", () => {
    expect(maxJobs()).toBe(Math.max(4, Math.floor(physicalCoreCount() / 2)));
    expect(resolveJobs()).toBe(maxJobs());
    expect(resolveJobs("auto")).toBe(maxJobs());
    expect(resolveJobs(4)).toBe(4);
    if (maxJobs() > 4) expect(resolveJobs(String(maxJobs()))).toBe(maxJobs());
    expect(() => resolveJobs(maxJobs() + 1)).toThrow();
  });

  test("counts distinct physical packages and cores on Linux", () => {
    if (process.platform !== "linux") return;
    const base = "/sys/devices/system/cpu";
    try {
      const status = readFileSync("/proc/self/status", "utf8");
      const allowed = status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];
      if (!allowed) return;
      const ids = new Set<number>();
      for (const group of allowed.split(",")) {
        const [start, end = start] = group.split("-").map(Number);
        for (let id = start; id <= end; id++) ids.add(id);
      }
      const pairs = new Set<string>();
      for (const entry of readdirSync(base)) {
        const match = /^cpu(\d+)$/.exec(entry);
        if (!match || !ids.has(Number(match[1]))) continue;
        const topology = `${base}/${entry}/topology`;
        const pkg = readFileSync(`${topology}/physical_package_id`, "utf8").trim();
        const core = readFileSync(`${topology}/core_id`, "utf8").trim();
        pairs.add(`${pkg}:${core}`);
      }
      expect(physicalCoreCount()).toBe(pairs.size || 1);
    } catch {
      expect(physicalCoreCount()).toBe(1);
    }
  });

  test('counts Windows physical cores from Win32_Processor rather than logical CPUs', () => {
    if (process.platform !== 'win32') return;
    const result = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance -ClassName Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum'], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000,
    });
    const count = Number(result.stdout.toString().trim());
    expect(physicalCoreCount()).toBe(result.exitCode === 0 && Number.isSafeInteger(count) && count > 0 ? count : 1);
  });

  test("rejects invalid job limits", () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "", "  ", "0", "-2", "1.5", "nope", "auto "]) {
      expect(() => resolveJobs(value)).toThrow();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("runQueue", () => {
  test("processes many items exactly once and returns results in input order", async () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const seen = new Set<number>();
    const results = await runQueue(items, 7, async (item, index) => {
      expect(item).toBe(index);
      expect(seen.has(item)).toBe(false);
      seen.add(item);
      return item * 2;
    });
    expect(seen.size).toBe(1000);
    expect(results).toEqual(items.map((item) => item * 2));
  });

  test("never exceeds the limit and starts only as many workers as items", async () => {
    const gates = Array.from({ length: 7 }, () => deferred<number>());
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const result = runQueue([0, 1, 2, 3, 4, 5, 6], 3, async (item, index) => {
      started.push(index);
      active++;
      peak = Math.max(peak, active);
      try { return await gates[item]!.promise; }
      finally { active--; }
    });
    expect(started).toEqual([0, 1, 2]);
    expect(peak).toBe(3);
    for (let i = 0; i < gates.length; i++) gates[i]!.resolve(i * 10);
    expect(await result).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(3);
    expect(active).toBe(0);
    const tiny = deferred<number>();
    const few = runQueue([1], 20, () => tiny.promise);
    tiny.resolve(42);
    expect(await few).toEqual([42]);
  });

  test("reuses a free slot without waiting for the other task", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const started: number[] = [];
    const result = runQueue(["slow", "fast", "next"], 2, (item, index) => {
      started.push(index);
      return index === 0 ? slow.promise : index === 1 ? fast.promise : Promise.resolve(item);
    });
    expect(started).toEqual([0, 1]);
    fast.resolve("fast done");
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    slow.resolve("slow done");
    expect(await result).toEqual(["slow done", "fast done", "next"]);
  });

  test("stops new claims on first failure, drains in-flight work, and preserves even falsy reasons", async () => {
    for (const failure of [undefined, false, 0, new Error("failed")]) {
      const bad = deferred<number>();
      const inFlight = deferred<number>();
      const started: number[] = [];
      const queue = runQueue([0, 1, 2, 3], 2, (_item, index) => {
        started.push(index);
        return index === 0 ? bad.promise : inFlight.promise;
      });
      let status = "pending";
      let reason: unknown = Symbol("unsettled");
      const observed = queue.then(
        () => { status = "resolved"; },
        (error: unknown) => { status = "rejected"; reason = error; },
      );
      bad.reject(failure);
      await Promise.resolve();
      const beforeDrain = status;
      const beforeClaim = [...started];
      if (failure === false) inFlight.reject(new Error("later failure"));
      else inFlight.resolve(1);
      await observed;
      expect(beforeDrain).toBe("pending");
      expect(beforeClaim).toEqual([0, 1]);
      expect(started).toEqual([0, 1]);
      expect(status).toBe("rejected");
      expect(reason).toBe(failure);
    }
  });

  test("a synchronous task throw also prevents new claims", async () => {
    const started: number[] = [];
    const outcome = await runQueue([0, 1], 1, async (_item, index) => {
      started.push(index);
      throw undefined;
    }).then(() => "resolved", (reason: unknown) => reason === undefined ? "rejected" : "wrong reason");
    expect(outcome).toBe("rejected");
    expect(started).toEqual([0]);
  });

  test("validates worker limits before doing work and accepts empty input", async () => {
    let calls = 0;
    const task = async () => { calls++; return "done"; };
    for (const jobs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(runQueue([1], jobs, task)).rejects.toThrow();
    }
    expect(calls).toBe(0);
    expect(await runQueue([], 2, task)).toEqual([]);
    expect(calls).toBe(0);
  });
});
