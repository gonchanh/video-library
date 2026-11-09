import { open, statfs } from 'node:fs/promises';
import { dirname, sep } from 'node:path';

/** No shell command line parsing; path data is separately encoded below. */
function powershellCommand(script: string): string[] {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function psString(value: string): string {
  if (value.includes('\0')) throw new Error('NUL in filesystem path');
  // PowerShell recognizes smart quotes too. Only Base64's ASCII alphabet enters script syntax.
  const encoded = Buffer.from(value, 'utf16le').toString('base64');
  return `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))`;
}

/** Publication is a single same-volume, non-replacing Win32 rename; no copy fallback. */
export function publicationCommand(source: string, target: string): string[] {
  if (process.platform !== 'win32') return ['mv', '--no-copy', '--update=none-fail', '--no-target-directory', '--', source, target];
  return windowsPublicationCommand(source, target);
}

/** Exported separately so Windows command encoding is testable on Linux. */
export function windowsPublicationCommand(source: string, target: string): string[] {
  return powershellCommand(`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VideoLibraryMove {
  [DllImport("kernel32.dll", EntryPoint="MoveFileExW", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool MoveFileEx(string source, string destination, uint flags);
}
'@
$source = ${psString(source)}
$target = ${psString(target)}
if (-not [VideoLibraryMove]::MoveFileEx($source, $target, 8)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "MoveFileExW failed (Win32 error $code)"
}`);
}

export function ffmpegCommand(args: string[]): string[] {
  return process.platform === 'win32' ? args : ['nice', '-n', '15', ...args];
}

/** statfs is retained unchanged for Linux; on Windows query the caller-available bytes, not total volume bytes. */
export async function availableBytes(path: string): Promise<number> {
  if (process.platform !== 'win32') {
    const space = await statfs(path);
    return space.bavail * space.bsize;
  }
  const result = Bun.spawnSync(windowsFreeSpaceCommand(path), { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
  const output = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !/^\d+$/.test(output)) throw new Error(`Cannot query destination free space: ${result.stderr.toString().trim() || output || `exit ${result.exitCode}`}`);
  return Number(BigInt(output) > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : BigInt(output));
}

/** Exported separately so all path encoding can be verified without a Windows host. */
export function windowsFreeSpaceCommand(path: string): string[] {
  return powershellCommand(`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VideoLibrarySpace {
  [DllImport("kernel32.dll", EntryPoint="GetDiskFreeSpaceExW", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetDiskFreeSpaceEx(string directory, out ulong available, out ulong total, out ulong free);
}
'@
[UInt64]$available = 0; [UInt64]$total = 0; [UInt64]$free = 0
if (-not [VideoLibrarySpace]::GetDiskFreeSpaceEx(${psString(path)}, [ref]$available, [ref]$total, [ref]$free)) { throw "GetDiskFreeSpaceExW failed (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
[Console]::WriteLine($available.ToString([Globalization.CultureInfo]::InvariantCulture))`);
}

/** Windows file handles can be flushed, but directory rename durability is not established. */
let warnedAboutWindowsDirectories = false;
export async function syncDirectories(start: string, stop: string = sep): Promise<void> {
  if (process.platform === 'win32') {
    if (!warnedAboutWindowsDirectories) {
      console.warn('Windows directory flush is not supported: publication is not guaranteed durable after power loss; automatic source cleanup is disabled.');
      warnedAboutWindowsDirectories = true;
    }
    return;
  }
  let dir = start;
  while (true) {
    const handle = await open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (dir === stop || dir === dirname(dir)) return;
    dir = dirname(dir);
  }
}

export async function durableOutput(path: string, root: string): Promise<void> {
  // Windows FlushFileBuffers requires GENERIC_WRITE on the file handle.
  const handle = await open(path, process.platform === 'win32' ? 'r+' : 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectories(dirname(path), root);
}

/** Never delete originals without durable directory/receipt publication semantics. */
export function assertCleanupDurability(): void {
  if (process.platform === 'win32') throw new Error('Automatic source cleanup is unavailable on Windows: durable directory publication cannot be guaranteed; keep originals and verify transfer manually');
}
