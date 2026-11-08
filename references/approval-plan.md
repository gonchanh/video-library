# Approval plan

Generate the approval report with the CLI `plan` command. It checks source identities, episode assignments, track selection, container compatibility, destination collisions and available space before writing the plan and presenting the report. These are preflight checks, not a claim that outputs have already been made or verified.

The output consists of the execution JSON at `--out` and a Markdown file with the same stem. The `Plan` type in `scripts/media.ts` defines execution data. `ApprovalPlan` and `renderApproval` in `scripts/approval.ts` define the review format. Use the generated report verbatim. Changes require regeneration and fresh approval.

## Required report

1. Plan path, canonical SHA-256 and measured generation time.
2. Source and destination roots, plus the episode-list reference.
3. Lossless operation, container policy, selected and dropped tracks, metadata treatment and original retention.
4. Parallel file limit and destination space required and available.
5. Explicit missing-episode warning, already-present episodes and unchanged files.
6. Every source-to-destination mapping, relative to the roots, with kept and dropped tracks.
7. Verification steps and the approval boundary.

An approval accepts the displayed mappings, policy and any missing-episode warning. All decisions must be resolved first. Pass `--approved-sha256` from the approved report to execute it. The plan's digest binds its concurrency limit as well as file mappings. Execution may lower that limit, never raise it without a new plan. The approved transfer runs without further questions, retaining originals. A changed file or failed check stops execution rather than asking for permission to weaken validation.

## Source deletion

After transfer verification, the user checks the files and confirms success. Only that later confirmation permits cleanup with `--delete-sources --confirm-transfer`. The initial plan never authorizes deletion.
