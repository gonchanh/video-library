import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** .NET Framework adds FILE_FLAG_FIRST_PIPE_INSTANCE when max server instances is one.
 * https://github.com/microsoft/referencesource/blob/main/System.Core/System/IO/Pipes/Pipe.cs
 */
export function windowsRunLockCommand(dir: string): string[] {
  const name = `video-library-${createHash('sha256').update(dir.toLowerCase()).digest('hex')}`;
  const script = `$ErrorActionPreference = 'Stop'
try {
  $pipe = [System.IO.Pipes.NamedPipeServerStream]::new(${JSON.stringify(name)}, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::None)
} catch [System.UnauthorizedAccessException] {
  [Console]::Error.WriteLine('LOCKED'); exit 73
}
try {
  [Console]::WriteLine('READY')
  $inputPipe = [Console]::OpenStandardInput()
  while ($inputPipe.ReadByte() -ne -1) { }
} finally { $pipe.Dispose() }`;
  // The lock holder must not be replaceable by a PATH shim: otherwise its process
  // could exit while a forwarded grandchild still owns the pipe.
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return [powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** The helper owns a first-instance Windows named pipe until its stdin closes or it is killed. */
async function withWindowsLock<T>(dir: string, action: () => Promise<T>): Promise<T> {
  const child = Bun.spawn(windowsRunLockCommand(dir), {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  let closing = false;
  let active = false;
  // If the holder disappears while action runs, terminate rather than continuing without exclusion.
  void child.exited.then(() => {
    if (active && !closing) {
      console.error('Windows run-lock holder exited unexpectedly; terminating unlocked process');
      process.exit(74);
    }
  });
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const reader = child.stdout.getReader();
    let line = '';
    try {
      while (!line.includes('\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        line += new TextDecoder().decode(value);
        if (line.length > 1024) throw new Error('Run-lock helper sent unexpected output');
      }
    } finally { reader.releaseLock(); }
    clearTimeout(timeout);
    if (!/^READY\r?\n/.test(line)) {
      closing = true;
      await child.exited;
      const detail = (await new Response(child.stderr).text()).trim();
      if (child.exitCode === 73 && detail.includes('LOCKED')) throw new Error('Run is locked by another process');
      throw new Error(`Could not acquire run lock: ${detail || `exit ${child.exitCode}`}`);
    }
    active = true;
    if (typeof child.exitCode === 'number' || child.signalCode) throw new Error('Windows run-lock holder exited before the action started');
    return await action();
  } finally {
    clearTimeout(timeout);
    closing = true;
    child.kill();
    await child.exited;
  }
}


/** Hold the lock on this process's open file description for the entire action. */
export async function withRunLock<T>(runDir: string, action: () => Promise<T>): Promise<T> {
  if (!isAbsolute(runDir)) throw new Error("runDir must be an absolute path");
  await mkdir(runDir, { recursive: true });
  const dir = await realpath(runDir);
  if (process.platform === 'win32') return withWindowsLock(dir, action);
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
