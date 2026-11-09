#!/usr/bin/env bun
import { TMDB } from "@lorenzopant/tmdb";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseJellyfinMetadata, type JellyfinMetadata } from "./structured";

export const metadataWarning = "Metadata can be wrong or incomplete. Review title, year and provider IDs before approval.";
export const fallbackWarning = "TMDB access unavailable. Use IMDb as the default movie reference; metadata needs manual review.";

export function tmdbClient(env: Record<string, string | undefined> = process.env): TMDB | undefined {
  const credential = env.api_read_access_token?.trim() || env.api_key?.trim();
  return credential ? new TMDB(credential, { language: "en-US", logger: false, retry: false, rate_limit: true }) : undefined;
}
export async function checkApi(client = tmdbClient()): Promise<{ available: boolean; message: string }> {
  if (client) {
    try {
      const result = await client.authentication.validate_key();
      if (result.success) return { available: true, message: `TMDB access verified. ${metadataWarning}` };
    } catch { /* Credentials, URLs and upstream error bodies never belong in logs. */ }
  }
  return { available: false, message: `${fallbackWarning} ${metadataWarning}` };
}
const requiredClient = (client?: TMDB) => client ?? (() => { throw new Error(fallbackWarning); })();
const validId = (id: number) => { if (!Number.isSafeInteger(id) || id < 1) throw new Error("A positive TMDB ID is required"); return id; };

export async function movieMetadata(id: number, client = tmdbClient()): Promise<JellyfinMetadata> {
  const data = await requiredClient(client).movies.details({ movie_id: validId(id), append_to_response: ["credits"] as const });
  if (data.id !== id) throw new Error("TMDB returned a different movie identity");
  return parseJellyfinMetadata(JSON.stringify({
    kind: "movie", title: data.title, year: data.release_date ? Number(data.release_date.slice(0, 4)) : null,
    plot: data.overview ?? null, genres: data.genres.map(genre => genre.name),
    studios: data.production_companies.map(company => company.name),
    directors: data.credits.crew.filter(person => person.job === "Director").map(person => person.name),
    actors: data.credits.cast.map(person => ({ name: person.name, role: person.character ?? null })),
    imdbId: data.imdb_id ?? null, tmdbId: data.id, season: null, episode: null, aired: null, showTitle: null,
    provider: "tmdb", reference: `https://www.themoviedb.org/movie/${data.id}`,
  }));
}
export async function episodeMetadata(seriesId: number, season: number, episode: number, client = tmdbClient()): Promise<JellyfinMetadata> {
  if (![season, episode].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 99)) throw new Error("Season and episode must be integers from 0 through 99");
  const api = requiredClient(client);
  const [series, data] = await Promise.all([
    api.tv_series.details({ series_id: validId(seriesId) }),
    api.tv_episodes.details({ series_id: seriesId, season_number: season, episode_number: episode, append_to_response: ["credits", "external_ids"] as const }),
  ]);
  if (series.id !== seriesId || data.season_number !== season || data.episode_number !== episode) throw new Error("TMDB returned a different episode identity");
  return parseJellyfinMetadata(JSON.stringify({
    kind: "episode", title: data.name, year: data.air_date ? Number(data.air_date.slice(0, 4)) : null,
    plot: data.overview ?? null, genres: series.genres.map(genre => genre.name),
    studios: (series.production_companies ?? []).map(company => company.name),
    directors: data.credits.crew.filter(person => person.job === "Director").map(person => person.name),
    actors: data.credits.cast.map(person => ({ name: person.name, role: person.character ?? null })),
    imdbId: data.external_ids.imdb_id ?? null, tmdbId: data.id, season, episode, aired: data.air_date ?? null, showTitle: series.name,
    provider: "tmdb", reference: `https://www.themoviedb.org/tv/${seriesId}/season/${season}/episode/${episode}`,
  }));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: {
    id: { type: "string" }, season: { type: "string" }, episode: { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help || !positionals.length) {
    console.log("Metadata planning artifacts, never media writes.\ncheck-api\nmovie --id TMDB_ID --out /run/movie.json\nepisode --id SERIES_TMDB_ID --season N --episode N --out /run/episode.json\nIMDb is the default movie reference without API access; supply reviewed metadata JSON using the structured schema.\n" + metadataWarning);
    return;
  }
  if (positionals.length !== 1) throw new Error("Expected one metadata command");
  if (positionals[0] === "check-api") { console.log(JSON.stringify(await checkApi())); return; }
  if (!values.out?.endsWith(".json")) throw new Error("Use --out with a new .json planning artifact outside media folders");
  const data = positionals[0] === "movie" ? await movieMetadata(Number(values.id))
    : positionals[0] === "episode" ? await episodeMetadata(Number(values.id), Number(values.season), Number(values.episode))
    : (() => { throw new Error("Unknown metadata command"); })();
  const path = resolve(values.out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
  console.log(`Metadata saved to ${path}. ${metadataWarning}`);
}
if (import.meta.main) {
  const timeout = setTimeout(() => { console.error("TMDB request timed out. " + fallbackWarning); process.exit(1); }, 15000);
  timeout.unref();
  try { await main(); }
  catch { console.error("Metadata lookup failed. Check the requested identity and API access. " + fallbackWarning); process.exitCode = 1; }
  finally { clearTimeout(timeout); }
}
