import { extname } from 'node:path';
import type { Probe } from './media';

export type ContainerProfile = Readonly<{
  extension: string; muxer: string;
  titleTag: boolean; languageTags: boolean; defaultFlags: boolean;
  subtitleLabel: 'title' | 'handler_name' | null; chapters: boolean;
  limitations: string;
}>;
const profile = (extension: string, muxer: string, titleTag: boolean, languageTags: boolean, defaultFlags: boolean,
  subtitleLabel: ContainerProfile['subtitleLabel'], chapters: boolean, limitations: string): ContainerProfile =>
  ({ extension, muxer, titleTag, languageTags, defaultFlags, subtitleLabel, chapters, limitations });
// Flags describe metadata FFprobe can read back after a stream-copy remux, not
// every feature the underlying container specification could theoretically carry.
const profiles: Record<string, ContainerProfile> = Object.fromEntries([
  profile('.mkv', 'matroska', true, true, true, 'title', true, 'Track/title metadata and chapters are retained; unsupported codecs still cause the approved FFmpeg operation to fail without fallback.'),
  profile('.mp4', 'mp4', true, true, true, 'handler_name', true, 'Only mov_text subtitles copy; subtitle labels use handler_name. MP4 may mark the first subtitle default despite a cleared flag.'),
  profile('.m4v', 'mp4', true, true, true, 'handler_name', true, 'MP4 rules apply: only mov_text subtitles copy, labels use handler_name and the first subtitle may be default.'),
  profile('.mov', 'mov', true, true, true, 'handler_name', true, 'Only mov_text subtitles copy; labels use handler_name and the first subtitle may be default.'),
  profile('.webm', 'webm', true, true, true, 'title', true, 'Only VP8/VP9/AV1 video, Vorbis/Opus audio and WebVTT subtitles copy.'),
  profile('.wmv', 'asf', true, true, false, null, false, 'ASF does not retain chapters, subtitle labels or default-track flags; selected subtitles are unsupported.'),
  profile('.avi', 'avi', true, false, false, null, false, 'AVI does not retain stream language/labels, default-track flags or chapters; only XSUB subtitle tracks can be copied.'),
  profile('.ts', 'mpegts', false, true, false, null, false, 'MPEG-TS does not retain global title, default-track flags or chapters; selected subtitles are unsupported.'),
  profile('.m2ts', 'mpegts', false, true, false, null, false, 'MPEG-TS does not retain global title, default-track flags or chapters; selected subtitles are unsupported.'),
  profile('.mts', 'mpegts', false, true, false, null, false, 'MPEG-TS does not retain global title, default-track flags or chapters; selected subtitles are unsupported.'),
  profile('.flv', 'flv', true, false, false, null, false, 'FLV does not retain stream language tags, default-track flags or chapters; selected subtitles are unsupported.'),
  profile('.mpg', 'mpeg', false, false, false, null, false, 'MPEG-PS does not retain global title, stream language tags, default-track flags or chapters; selected subtitles are unsupported.'),
  profile('.mpeg', 'mpeg', false, false, false, null, false, 'MPEG-PS does not retain global title, stream language tags, default-track flags or chapters; selected subtitles are unsupported.'),
  profile('.ogv', 'ogg', false, true, false, null, false, 'Ogg does not retain global title, default-track flags or chapters; selected subtitles are unsupported.'),
].map(p => [p.extension, p]));

export function containerProfile(extension: string): ContainerProfile {
  const p = profiles[extension.toLowerCase()];
  if (!p || !extension.startsWith('.')) throw new Error(`Unsupported output container: ${extension}`);
  return p;
}
export const videoExtensions = new Set(Object.keys(profiles));
export function targetExtension(source: string, override?: string): string {
  const extension = override === undefined ? extname(source).toLowerCase() : override.toLowerCase();
  containerProfile(extension);
  return extension;
}
export function checkContainer(p: ContainerProfile, probe: Probe, selected: number[]): void {
  const streams = selected.map(index => probe.streams.find(stream => stream.index === index) ?? (() => { throw new Error(`Unknown selected stream ${index}`); })());
  const reject = (reason: string): never => { throw new Error(`${p.extension} cannot preserve selected tracks/chapters: ${reason}. ${p.limitations}`); };
  if (!p.chapters && probe.chapters?.length) reject('chapters are unsupported');
  if (!p.subtitleLabel && streams.some(s => s.codec_type === 'subtitle') && !(p.muxer === 'avi' && streams.filter(s => s.codec_type === 'subtitle').every(s => s.codec_name === 'xsub'))) reject('selected subtitle codec is unsupported');
  if (['mp4', 'mov'].includes(p.muxer) && streams.some(s => s.codec_type === 'subtitle' && s.codec_name !== 'mov_text')) reject('subtitle codec is not copy-compatible (mov_text required)');
  if (p.muxer === 'webm') {
    const allowed: Record<string, string[]> = { video: ['vp8', 'vp9', 'av1'], audio: ['vorbis', 'opus'], subtitle: ['webvtt'] };
    for (const s of streams) if (!allowed[s.codec_type]?.includes(s.codec_name)) reject(`${s.codec_type} codec ${s.codec_name} is not WebM-compatible`);
  }
  if (p.muxer === 'flv') {
    const allowed: Record<string, string[]> = { video: ['flv1', 'h264', 'vp6f', 'vp6a'], audio: ['mp3', 'aac', 'nellymoser', 'speex'] };
    for (const s of streams) if (!allowed[s.codec_type]?.includes(s.codec_name)) reject(`${s.codec_type} codec ${s.codec_name} is not FLV-compatible`);
  }
  if (p.muxer === 'ogg') {
    for (const s of streams) if ((s.codec_type === 'video' && s.codec_name !== 'theora') || (s.codec_type === 'audio' && !['vorbis', 'opus'].includes(s.codec_name))) reject(`${s.codec_type} codec ${s.codec_name} is not Ogg-compatible`);
  }
  if (p.muxer === 'mpeg') {
    for (const s of streams) if ((s.codec_type === 'video' && !['mpeg1video', 'mpeg2video', 'mpeg4', 'h264'].includes(s.codec_name)) || (s.codec_type === 'audio' && !['mp1', 'mp2', 'mp3', 'pcm_dvd', 'pcm_s16be', 'ac3', 'dts'].includes(s.codec_name))) reject(`${s.codec_type} codec ${s.codec_name} is not MPEG-PS-compatible`);
  }
}
