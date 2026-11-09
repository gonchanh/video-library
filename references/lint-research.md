# Oxlint rationale

The repository uses [type-aware Oxlint](https://oxc.rs/docs/guide/usage/linter/type-aware) with `oxlint-tsgolint`, followed by the independent Bun typecheck. `.oxlintrc.json` is the rule source of truth. [Configuration](https://oxc.rs/docs/guide/usage/linter/config) and the [rule catalog](https://oxc.rs/docs/guide/usage/linter/rules) explain current options.

Correctness and suspicious rules are errors; performance diagnostics are warnings. Explicit rules catch floating or misused promises, unnecessary awaits in implementation code, explicit `any`, unsafe finalizers, dynamic code evaluation and loose equality. Generated BAML bridge files are ignored, not handwritten parsers or tests.

Exceptions have specific reasons:

- Ordered directory flushes, lock readiness and bounded queues must await loop iterations. A blanket `no-await-in-loop` would recommend unbounded work or break ordering.
- Runtime JSON validators attest their parsed types. A blanket type-assertion ban conflicts with those validation boundaries; Bun typecheck still checks callers.
- Bun's asynchronous `.rejects` matchers are typed as non-Promise values. Tests must still await them, so `await-thenable` is disabled only for test files.
- Mutating a newly created local array and keeping a small test helper local are not correctness defects. Those cosmetic rules are disabled rather than forcing allocation or unrelated code movement.

Formatter rules, experimental categories and bulk style fixes are intentionally absent. Run the full doctor after changing rules so stronger checks do not silently remove meaningful test coverage.
