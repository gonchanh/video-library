import { readFileSync, readdirSync } from "node:fs";

/** Return 1 when Linux topology or process affinity cannot be read; never equate logical CPUs with cores. */
export function physicalCoreCount(): number {
  if (process.platform !== "linux") return 1;
  try {
    const allowed = readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];
    if (!allowed) return 1;
    const ids = new Set<number>();
    for (const range of allowed.split(",")) {
      const match = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!match) return 1;
      const start = Number(match[1]);
      const end = match[2] === undefined ? start : Number(match[2]);
      if (!Number.isSafeInteger(end) || end < start) return 1;
      for (let id = start; id <= end; id++) ids.add(id);
    }
    const base = "/sys/devices/system/cpu";
    const cores = new Set<string>();
    for (const entry of readdirSync(base)) {
      const match = /^cpu(\d+)$/.exec(entry);
      if (!match || !ids.has(Number(match[1]))) continue;
      const topology = `${base}/${entry}/topology`;
      const pkg = readFileSync(`${topology}/physical_package_id`, "utf8").trim();
      const core = readFileSync(`${topology}/core_id`, "utf8").trim();
      if (!/^\d+$/.test(pkg) || !/^\d+$/.test(core)) return 1;
      cores.add(`${pkg}:${core}`);
    }
    return cores.size || 1;
  } catch {
    return 1;
  }
}

export function maxJobs(): number {
  return Math.max(4, Math.floor(physicalCoreCount() / 2));
}

export function resolveJobs(value: string | number | undefined = "auto"): number {
  const cap = maxJobs();
  if (value === "auto") return cap;
  const jobs = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof jobs !== "number" || !Number.isSafeInteger(jobs) || jobs < 1 || jobs > cap) {
    throw new Error(`jobs must be a positive safe integer <= ${cap}`);
  }
  return jobs;
}

export async function runQueue<T, R>(items: readonly T[], jobs: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("jobs must be a positive safe integer");
  const results: R[] = [];
  let next = 0;
  let failed = false;
  let reason: unknown;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        if (!failed) { failed = true; reason = error; }
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, () => worker()));
  if (failed) throw reason;
  return results;
}
