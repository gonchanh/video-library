import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Hold the lock on this process's open file description for the entire action. */
export async function withRunLock<T>(runDir: string, action: () => Promise<T>): Promise<T> {
  if (!isAbsolute(runDir)) throw new Error("runDir must be an absolute path");
  await mkdir(runDir, { recursive: true });
  const dir = await realpath(runDir);
  const handle = await open(join(dir, "apply.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Run lock must be a regular file");
    // flock inherits fd 0 from the parent's handle. The child exits, but the
    // shared open file description stays locked until this handle is closed.
    const result = Bun.spawnSync(["flock", "-n", "-E", "73", "0"], {
      stdin: handle.fd, stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    if (result.exitCode === 73) throw new Error("Run is locked by another process");
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString().trim() || `exit ${result.exitCode}, signal ${result.signalCode}`;
      throw new Error(`Could not acquire run lock: ${detail}`);
    }
    return await action();
  } finally {
    await handle.close();
  }
}
