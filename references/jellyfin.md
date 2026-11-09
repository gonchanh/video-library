# Jellyfin metadata reference

Read this when changing NFO output, provider mappings or the server integration test. Follow the current primary documentation rather than treating saved API examples as permanent contracts.

## Sources

- [Jellyfin NFO metadata](https://jellyfin.org/docs/general/server/metadata/nfo/): filenames, supported tags and priority over remote metadata.
- [Jellyfin configuration](https://jellyfin.org/docs/general/administration/configuration/): independent data/config/cache paths.
- [Jellyfin API reference](https://api.jellyfin.org/): current request and response schemas.
- [Startup controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/StartupController.cs), [library structure](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/LibraryStructureController.cs), [items](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/ItemsController.cs): implementation references when the installed API differs.
- [Typed TMDB client](https://github.com/lorenzopant/tmdb) and [TMDB authentication](https://developer.themoviedb.org/docs/authentication-application): lookup types and credentials.
- [BAML quickstart](https://boundaryml.com/quickstart) and [TypeScript bridge](https://developer.boundaryml.com/baml/bridges/typescript): version-matched local validation.

## Sidecar contract

Write `<video filename without extension>.nfo` beside each video. Flat movie libraries need distinct sidecars, not one shared `movie.nfo`. Movie XML uses `<movie>`; episode XML uses `<episodedetails>`.

The renderer writes title, optional year/plot, repeated genre/studio/director tags, actor name and role, and `<uniqueid type="imdb">` or `<uniqueid type="tmdb">`. Episode fields add season, episode, aired and showtitle. An episode's TMDB ID is its episode ID, not its series ID. Empty optional facts remain absent rather than invented. XML text is escaped.

BAML checks format and basic identity bounds, not factual correctness. Confirm title, year and provider IDs against the reference before approval. The transfer plan stores metadata, so apply and resume need no API or model access.

## Observed verification

The installed Jellyfin Server `12.4.0.0` imported two different movie sidecars from one flat folder and an episode sidecar. Assertions checked titles, years, plots, genres, actor roles, provider IDs and episode numbering. The test exercises CLI planning, approval digest, publication and verification before import, and confirms source hashes remain unchanged.

`doctor` runs this test with temporary data/config/cache/log directories and a separate loopback HTTP listener. It disables Internet metadata providers and does not use the configured Jellyfin service or libraries. The script removes its successful-run fixtures after stopping its server; failed runs retain diagnostic logs.

Jellyfin can list an item before its actor records are ready. The test waits for every asserted field, with a deadline, and still rejects persistent wrong metadata. Its focused regression covers missing actors and wrong roles. On this installed version, `--version` prints a valid version but exits with status 1; doctor accepts only that exact recognized version response.

Linux execution passed. Windows adapters and listener inspection have source review but remain machine-untested. Refer to `scripts/jellyfin-e2e.ts` for the actual installed-version setup and API calls rather than duplicating them here.
