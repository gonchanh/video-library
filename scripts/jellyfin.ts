import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { Item } from "./media";
import type { JellyfinMetadata } from "./structured";

export const metadataPath = (item: Pick<Item, "target">) => item.target.slice(0, -extname(item.target).length) + ".nfo";
const xml = (value: string) => {
  // XML 1.0 cannot represent these controls or lone UTF-16 surrogates.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(value)) throw new Error("Metadata contains a character forbidden by XML 1.0");
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
};
const tag = (name: string, value: string | number | null | undefined) => value === null || value === undefined ? "" : `  <${name}>${xml(String(value))}</${name}>\n`;

export function renderNfo(metadata: JellyfinMetadata): string {
  const root = metadata.kind === "movie" ? "movie" : "episodedetails";
  return `<?xml version="1.0" encoding="utf-8"?>\n<${root}>\n` +
    tag("title", metadata.title) + tag("year", metadata.year) + tag("plot", metadata.plot) +
    metadata.genres.map(value => tag("genre", value)).join("") + metadata.studios.map(value => tag("studio", value)).join("") +
    metadata.directors.map(value => tag("director", value)).join("") +
    metadata.actors.map(actor => `  <actor>\n${tag("name", actor.name)}${tag("role", actor.role)}  </actor>\n`).join("") +
    (metadata.imdbId ? `  <uniqueid type="imdb">${xml(metadata.imdbId)}</uniqueid>\n` : "") +
    (metadata.tmdbId ? `  <uniqueid type="tmdb">${metadata.tmdbId}</uniqueid>\n` : "") +
    (metadata.kind === "episode" ? tag("season", metadata.season) + tag("episode", metadata.episode) + tag("aired", metadata.aired) + tag("showtitle", metadata.showTitle) : "") +
    `</${root}>\n`;
}
export const metadataHash = (metadata: JellyfinMetadata) => createHash("sha256").update(renderNfo(metadata)).digest("hex");
