// Agent-authored JSON is parsed and validated locally. No LLM client is configured.
class ApprovalOutput {
    source: string,
    destination: string,
    kept: string[],
    dropped: string[],
    containerNotes: string,
}

class ApprovalPlan {
    version: 1,
    kind: "tv" | "movies",
    planPath: string,
    planSha256: string,
    generatedInMs: int,
    source: string,
    destination: string,
    reference: string,
    jobs: int,
    requiredFreeBytes: int,
    availableFreeBytes: int,
    missing: string[],
    existing: string[],
    ignored: string[],
    languageOverrides: string[],
    metadata: string[],
    outputs: ApprovalOutput[],
}

class JellyfinActor {
    name: string,
    role: string?,
}

class JellyfinMetadata {
    kind: "movie" | "episode",
    title: string,
    reference: string,
    provider: "tmdb" | "imdb" | "user",
    year: int?,
    plot: string?,
    genres: string[],
    studios: string[],
    directors: string[],
    actors: JellyfinActor[],
    imdbId: string?,
    tmdbId: int?,
    season: int?,
    episode: int?,
    aired: string?,
    showTitle: string?,
}

function non_empty(text: string) -> bool {
    text.trim().length() > 0
}

function valid_reference(url: string) -> bool {
    // Absolute HTTP(S) URL with a host, e.g. https://www.imdb.com/title/tt1234567/.
    baml.regex.new(`^https?://[^\\s/?#]+(?:[/?#][^\\s]*)?$`).has_match(url)
}

function parseApprovalPlan(
    raw: string,
) -> ApprovalPlan throws baml.json.ParseError | baml.json.DecodeError | baml.errors.InvalidArgument | baml.regex.Error {
    let plan = baml.json.decode<ApprovalPlan>(raw);
    if (
        !non_empty(plan.planPath)
            || !non_empty(plan.source)
            || !non_empty(plan.destination)
            || !valid_reference(plan.reference)
    ) {
        throw baml.errors.InvalidArgument { message: "approval plan requires paths and an HTTP(S) reference" }
    }
    // SHA-256 hex digest: exactly 64 hexadecimal characters.
    if (!baml.regex.new(`^[a-fA-F0-9]{64}$`).has_match(plan.planSha256)) {
        throw baml.errors.InvalidArgument { message: "planSha256 must be a SHA-256 hex digest" }
    }
    if (
        plan.generatedInMs < 0
            || plan.jobs < 1
            || plan.requiredFreeBytes < 0
            || plan.availableFreeBytes < 0
    ) {
        throw baml.errors.InvalidArgument { message: "approval plan has invalid numeric bounds" }
    }
    if (
        !plan.outputs.every((output) -> {
            non_empty(output.source)
                && non_empty(output.destination)
                && non_empty(output.containerNotes)
        })
    ) {
        throw baml.errors.InvalidArgument { message: "approval output requires source, destination and container notes" }
    }
    plan
}

function parseJellyfinMetadata(
    raw: string,
) -> JellyfinMetadata throws baml.json.ParseError | baml.json.DecodeError | baml.errors.InvalidArgument | baml.regex.Error {
    let metadata = baml.json.decode<JellyfinMetadata>(raw);
    if (!non_empty(metadata.title) || !valid_reference(metadata.reference)) {
        throw baml.errors.InvalidArgument { message: "metadata requires a title and an HTTP(S) reference" }
    }
    let imdb = metadata.imdbId;
    if (imdb != null && !baml.regex.new(`^tt[0-9]{7,}$`).has_match(imdb)) {
        throw baml.errors.InvalidArgument { message: "imdbId must be a valid tt identifier" }
    }
    let tmdb = metadata.tmdbId;
    if (tmdb != null && tmdb < 1) {
        throw baml.errors.InvalidArgument { message: "tmdbId must be positive" }
    }
    let year = metadata.year;
    if (year != null && (year < 1878 || year > 2100)) {
        throw baml.errors.InvalidArgument { message: "year is outside the supported release range" }
    }
    let season = metadata.season;
    let episode = metadata.episode;
    let show = metadata.showTitle;
    if (
        metadata.kind == "episode"
            && (
                season == null
                    || season < 0
                    || episode == null
                    || episode < 0
                    || show == null
                    || !non_empty(show)
            )
    ) {
        throw baml.errors.InvalidArgument { message: "episodes require a show title, nonnegative season and positive episode number" }
    }
    if (metadata.kind == "movie" && (season != null || episode != null || show != null)) {
        throw baml.errors.InvalidArgument { message: "movie metadata cannot have episode identity" }
    }
    if (
        !metadata.actors.every((actor) -> {
            non_empty(actor.name)
        })
    ) {
        throw baml.errors.InvalidArgument { message: "actor names cannot be empty" }
    }
    metadata
}
