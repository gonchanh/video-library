---
name: video-library
description: Organize and verify video libraries with approved, lossless cleanup plans.
disable-model-invocation: true
---

# Video library

Use the CLI in this skill directory. Preserve the input container and extension unless the user explicitly requests another format. Copy selected tracks without re-encoding. Keep run files outside the skill and scanned media folders. For implementation details, consult [scripts and types](references/scripts-and-types.md); use CLI `--help` for current command syntax.

1. Run `bun run doctor` first. It bootstraps or updates dependencies and runs the full checks. Stop on failure; follow its output and CLI `--help` for next steps.
2. Establish source, destination, show, season and layout. Require an episode-list URL and the complete expected season list before any media operation. Check the source's episode table for numbering and titles, then inventory source and destination. Account for every video, including duplicates, unexpected files and gaps. Resolve ambiguous identities and duplicate treatment before planning. Ask the human about choices inspection cannot settle.
3. Generate a typed CLI plan. It produces a verified `plan.json` and its human-readable `plan.md` together; see [approval plan](references/approval-plan.md) for the stable report schema. Present only the verified generated report, never a freehand substitute. The report must identify mappings, selected tracks, missing episodes, collisions, verification and source retention. Warn explicitly about missing episodes and obtain human acceptance as part of approval. Resolve all execution decisions before asking the human to approve this specific fresh plan. Regenerate after any input or policy change.
4. After explicit approval, apply that same plan, passing `--approved-sha256` from the approved report, and use the same plan and run for `--resume`. Approval is required before any media write, move, sample or deletion. Transfer retains all originals and runs unattended after approval. The queue cap and default are `max(4, floor(physical cores / 2))`; `--jobs` may only lower that value. FFmpeg uses native threading. A persistent, kernel-held `apply.lock` guards the run; never unlink it. Corrupt inputs and output collisions fail closed, preserving sources.
5. Verify published outputs against the plan and receipts. Show the verification report, then stop for HUMAN confirmation that transfer and playback succeeded. Only after that confirmation may a separate cleanup run with `--delete-sources --confirm-transfer`. Initial plan approval is not deletion consent. Cleanup preflights the entire batch before deleting any source. Report retained and deleted files and accepted gaps.

Default track policy: keep English audio, with the first audio track default; keep regular English and English SDH subtitles, all nondefault and nonforced. Preserve chapters. Stop planning for untagged or unknown-language tracks and for styled subtitles whose required fonts need review. Resolve those cases with the human before generating an approvable plan.
