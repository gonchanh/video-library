import { readdir } from "node:fs/promises";
import { basename, dirname, relative, sep } from "node:path";
import { approvedJobs, episodeId, isMovieCatalog, safeName, type Item, type Plan } from "./media";
import { metadataPath, renderNfo } from "./jellyfin";
import { runQueue } from "./queue";
import { parseJellyfinMetadata } from "./structured";

function identity(plan: Plan, item: Item) {
  const catalog = plan.catalog;
  if (isMovieCatalog(catalog)) {
    const key = relative(plan.sourceRoot, item.source).split(sep).join("/");
    const movie = catalog.movies.find(entry => entry.file === key);
    if (!movie) throw new Error(`Missing movie identity for ${key}`);
    return { kind: "movie" as const, title: movie.title, year: movie.year, reference: movie.reference, season: null, episode: null, showTitle: null };
  }
  const id = episodeId(basename(item.source));
  const entry = catalog.episodes.find(episode => id === `S${String(catalog.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`);
  if (!entry) throw new Error(`Missing episode identity for ${item.source}`);
  return { kind: "episode" as const, title: entry.title, year: null, reference: catalog.reference, season: catalog.season, episode: entry.episode, showTitle: catalog.show };
}

const identityTitle = (value: string) => safeName(value).normalize("NFKC").toLowerCase();

export async function attachMetadata(plan: Plan, supplied: unknown = {}): Promise<Plan> {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("Metadata must map source-relative filenames to reviewed objects");
  const records = supplied as Record<string, unknown>;
  const keys = new Set(plan.items.map(item => relative(plan.sourceRoot, item.source).split(sep).join("/")));
  for (const key of Object.keys(records)) if (!keys.has(key)) throw new Error(`Metadata names an unplanned source: ${key}`);
  const items = await runQueue(plan.items, approvedJobs(plan), async item => {
    const expected = identity(plan, item), key = relative(plan.sourceRoot, item.source).split(sep).join("/");
    const reference = new URL(expected.reference);
    const imdbId = /(^|\.)imdb\.com$/i.test(reference.hostname) ? reference.pathname.match(/\/title\/(tt\d{7,})/)?.[1] ?? null : null;
    const metadata = parseJellyfinMetadata(JSON.stringify(Object.hasOwn(records, key) ? records[key] : {
      ...expected, provider: imdbId ? "imdb" : "user", imdbId, tmdbId: null,
      plot: null, genres: [], studios: [], directors: [], actors: [], aired: null,
    }));
    if (metadata.kind !== expected.kind || identityTitle(metadata.title) !== identityTitle(expected.title) ||
      (expected.kind === "movie" && metadata.year !== expected.year) ||
      (expected.kind === "episode" && (metadata.season !== expected.season || metadata.episode !== expected.episode || identityTitle(metadata.showTitle ?? "") !== identityTitle(expected.showTitle ?? "")))) {
      throw new Error(`Metadata identity disagrees with catalog: ${key}`);
    }
    renderNfo(metadata);
    const path = metadataPath(item);
    const siblings = await readdir(dirname(path)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (siblings.some(name => name.toLowerCase() === basename(path).toLowerCase())) throw new Error(`Metadata target already exists: ${path}`);
    return { ...item, metadata };
  });
  return { ...plan, items };
}
