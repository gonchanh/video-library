import { expect, test } from "bun:test";
import { TMDB } from "@lorenzopant/tmdb";
import { checkApi, episodeMetadata, movieMetadata, tmdbClient } from "./tmdb";

test("TMDB credentials use the documented environment names and remain optional", () => {
  expect(tmdbClient({})).toBeUndefined();
  expect(tmdbClient({ api_key: "fixture-key" })).toBeInstanceOf(TMDB);
  expect(tmdbClient({ api_read_access_token: "fixture-token", api_key: "fixture-key" })).toBeInstanceOf(TMDB);
});
test("API failures produce an IMDb fallback warning without leaking credentials or URLs", async () => {
  const client = new TMDB("fixture-secret");
  client.authentication.validate_key = async () => { throw new Error("https://example.org?api_key=fixture-secret"); };
  const result = await checkApi(client);
  expect(result.available).toBe(false);
  expect(result.message).toContain("IMDb");
  expect(result.message).not.toContain("fixture-secret");
  expect(result.message).not.toContain("api_key=");
});
test("invalid lookup identities fail before any network call", async () => {
  const client = new TMDB("fixture-key");
  await expect(movieMetadata(0, client)).rejects.toThrow("positive TMDB ID");
  await expect(episodeMetadata(1, -1, 1, client)).rejects.toThrow("Season and episode");
});
