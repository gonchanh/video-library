import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCleanupDurability, availableBytes, durableOutput, ffmpegCommand, publicationCommand, windowsFreeSpaceCommand, windowsPublicationCommand } from './platform';

function decode(command: string[]) {
  expect(command.slice(0, 4)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  return Buffer.from(command[4], 'base64').toString('utf16le');
}

test('Windows publication uses non-replacing, same-volume-only MoveFileExW', () => {
  const source = "C:\\vid's\\雪 & [x] ; `$(Write-Host evil).mkv";
  const target = 'D:\\film \'[a] Ω.mkv';
  const script = decode(windowsPublicationCommand(source, target));
  expect(encodedPaths(script)).toEqual([source, target]);
  expect(script).toContain('EntryPoint="MoveFileExW"');
  expect(script).toContain('MoveFileEx($source, $target, 8)');
  expect(script).not.toMatch(/COPY_ALLOWED|REPLACE_EXISTING/);
  expect(script).toContain('throw "MoveFileExW failed');
  expect(() => windowsPublicationCommand('C:\\a\0b', 'C:\\c')).toThrow('NUL');
});

function encodedPaths(script: string): string[] {
  return [...script.matchAll(/\[Text\.Encoding\]::Unicode\.GetString\(\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]*)'\)\)/g)]
    .map(match => Buffer.from(match[1], 'base64').toString('utf16le'));
}

test('Windows paths remain data even with ASCII/smart quotes, Unicode, and PowerShell syntax', () => {
  const paths = [
    "C:\\a’; throw ’INJECTED’; #.mkv",
    'C:\\‘left’ and “right”\\雪 Ω 🐈.mkv',
    "C:\\apostrophe's & [x] ; `$(throw 'INJECTED') #.mkv",
    'C:\\one\\..\\two\\newline\nname.mkv',
  ];
  for (const path of paths) {
    const publication = decode(windowsPublicationCommand(path, path + '.target'));
    const freeSpace = decode(windowsFreeSpaceCommand(path));
    expect(encodedPaths(publication)).toEqual([path, path + '.target']);
    expect(encodedPaths(freeSpace)).toEqual([path]);
    for (const script of [publication, freeSpace]) {
      expect(script).not.toContain(path);
      expect(script).not.toContain('INJECTED');
    }
    expect(freeSpace).toContain('EntryPoint="GetDiskFreeSpaceExW"');
    expect(freeSpace).toContain('throw "GetDiskFreeSpaceExW failed');
  }
  expect(() => windowsFreeSpaceCommand('C:\\a\0b')).toThrow('NUL');
  expect(() => windowsPublicationCommand('C:\\ok', 'C:\\a\0b')).toThrow('NUL');
});

test('OS command selection preserves Linux GNU mv and nice policy', () => {
  if (process.platform === 'win32') {
    expect(publicationCommand('C:\\a', 'C:\\b')).toEqual(windowsPublicationCommand('C:\\a', 'C:\\b'));
    expect(ffmpegCommand(['ffmpeg', '-n'])).toEqual(['ffmpeg', '-n']);
    expect(() => assertCleanupDurability()).toThrow('unavailable on Windows');
  } else {
    expect(publicationCommand('/a', '/b')).toEqual(['mv', '--no-copy', '--update=none-fail', '--no-target-directory', '--', '/a', '/b']);
    expect(ffmpegCommand(['ffmpeg', '-n'])).toEqual(['nice', '-n', '15', 'ffmpeg', '-n']);
    expect(() => assertCleanupDurability()).not.toThrow();
  }
});

test('native publication refuses collisions and missing sources without changing existing data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-library-publication-'));
  try {
    const source = join(dir, 'source.mkv'), target = join(dir, 'target.mkv');
    await writeFile(source, 'original');
    await writeFile(target, 'unrelated');
    const run = () => Bun.spawnSync(publicationCommand(source, target), { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 15000 });
    expect(run().exitCode).not.toBe(0);
    expect(await readFile(source, 'utf8')).toBe('original');
    expect(await readFile(target, 'utf8')).toBe('unrelated');
    await rm(target);
    expect(run().exitCode).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(run().exitCode).not.toBe(0);
    expect(await readFile(target, 'utf8')).toBe('original');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('free-space probe and file flush do not claim Windows directory durability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-library-platform-'));
  try {
    const path = join(dir, 'file');
    await writeFile(path, 'data');
    const space = await availableBytes(dir);
    expect(Number.isSafeInteger(space) && space > 0).toBe(true);
    await durableOutput(path, dir);
    expect(await readFile(path, 'utf8')).toBe('data');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
