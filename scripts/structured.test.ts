import { describe, expect, test } from "bun:test";
import { parseApprovalPlan, parseJellyfinMetadata } from "./structured";

const approval = {
  version: 1,
  kind: "tv",
  planPath: "/tmp/plan.json",
  planSha256: "a".repeat(64),
  generatedInMs: 50,
  source: "/input",
  destination: "/output",
  reference: "https://www.themoviedb.org/tv/10",
  jobs: 2,
  requiredFreeBytes: 100,
  availableFreeBytes: 200,
  missing: [],
  existing: [],
  ignored: [],
  languageOverrides: [],
  metadata: [],
  outputs: [{ source: "episode.mkv", destination: "S01E01.mkv", kept: ["#0 video"], dropped: [], containerNotes: "Matroska" }],
};

const movie = {
  kind: "movie",
  title: "The Film",
  reference: "https://www.themoviedb.org/movie/42",
  provider: "tmdb",
  year: 2001,
  plot: null,
  genres: ["Drama"],
  studios: [],
  directors: [],
  actors: [{ name: "A. Actor", role: null }],
  imdbId: "tt1234567",
  tmdbId: 42,
  season: null,
  episode: null,
  aired: null,
  showTitle: null,
};

function altered(base: object, changes: object): string {
  return JSON.stringify({ ...base, ...changes });
}

describe("local BAML approval parsing", () => {
  test("returns a validated, generated type without a provider key", () => {
    const result = parseApprovalPlan(JSON.stringify(approval));
    expect(result.outputs[0]?.kept).toEqual(["#0 video"]);
    expect(result.version).toBe(1);
  });

  test.each([
    "{",
    altered(approval, { version: 2 }),
    altered(approval, { planSha256: "not-a-digest" }),
    altered(approval, { reference: "file:///tmp/local" }),
    altered(approval, { jobs: 0 }),
    altered(approval, { outputs: [{ source: "x", destination: "y", kept: "not-array", dropped: [], containerNotes: "notes" }] }),
    altered(approval, { missing: null }),
  ])("rejects invalid approval JSON: %s", raw => {
    expect(() => parseApprovalPlan(raw)).toThrow();
  });
});

describe("local BAML Jellyfin metadata parsing", () => {
  test("validates movie and episode identities", () => {
    expect(parseJellyfinMetadata(JSON.stringify(movie)).tmdbId).toBe(42);
    const episode = { ...movie, kind: "episode", title: "Pilot", season: 0, episode: 1, showTitle: "Example" };
    expect(parseJellyfinMetadata(JSON.stringify(episode)).episode).toBe(1);
  });

  test("accepts absent optional values, never missing required arrays", () => {
    const { year: _year, plot: _plot, imdbId: _imdbId, tmdbId: _tmdbId, season: _season, episode: _episode, aired: _aired, showTitle: _showTitle, ...minimal } = movie;
    expect(parseJellyfinMetadata(JSON.stringify(minimal)).title).toBe("The Film");
    const { genres: _genres, ...missingArray } = minimal;
    expect(() => parseJellyfinMetadata(JSON.stringify(missingArray))).toThrow();
  });

  test.each([
    "[1,2]",
    altered(movie, { title: " " }),
    altered(movie, { kind: "unknown" }),
    altered(movie, { provider: "unknown" }),
    altered(movie, { reference: "ftp://example.org/movie" }),
    altered(movie, { tmdbId: 0 }),
    altered(movie, { imdbId: "1234567" }),
    altered(movie, { year: 0 }),
    altered(movie, { year: 2001.5 }),
    altered(movie, { episode: 1 }),
    altered(movie, { kind: "episode", episode: -1, season: 1, showTitle: "Show" }),
    altered(movie, { kind: "episode", episode: 1, season: -1, showTitle: "Show" }),
    altered(movie, { kind: "episode", episode: 1, season: 1, showTitle: null }),
    altered(movie, { actors: [{ name: "", role: null }] }),
  ])("rejects malformed metadata: %s", raw => {
    expect(() => parseJellyfinMetadata(raw)).toThrow();
  });
});
