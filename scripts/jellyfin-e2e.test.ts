import { expect, test } from 'bun:test';
import { metadataMismatch } from './jellyfin-e2e';
import { parseJellyfinMetadata } from './structured';

test('name visible before actor import is not full metadata readiness', () => {
  const expected = parseJellyfinMetadata(JSON.stringify({ kind: 'movie', title: 'Copper Lantern', reference: 'https://example.org/fixture', provider: 'user', year: 2003, plot: 'Fixture plot', genres: ['FixtureGenre'], studios: [], directors: [], actors: [{ name: 'Fixture Actor', role: 'Role 1' }], imdbId: 'tt0991001', tmdbId: 991001, season: null, episode: null, aired: null, showTitle: null }));
  const nameVisible = { Id: '1', Name: expected.title, ProductionYear: 2003, Overview: 'Fixture plot', Genres: expected.genres, ProviderIds: { Imdb: expected.imdbId!, Tmdb: String(expected.tmdbId) } };
  expect(metadataMismatch(nameVisible, expected)).toContain('actor role mismatch');
  expect(metadataMismatch({ ...nameVisible, People: [{ Name: 'Fixture Actor', Role: 'Wrong Role' }] }, expected)).toContain('actor role mismatch');
  expect(metadataMismatch({ ...nameVisible, People: [{ Name: 'Fixture Actor', Role: 'Role 1' }] }, expected)).toBeNull();
});
