# Strict functional/procedural lint policy

[Compare conflicting rules with real-code examples](lint-conflicts.html) — dark, three-column previews; choices do not change configuration.

## Applied setup

Oxlint is the **only linter program**. Existing commands stay unchanged:

```sh
bun run lint       # oxlint
bun run lint:fix   # oxlint --fix
```

Configuration: [`.oxlintrc.json`](../.oxlintrc.json). Two root development dependencies supply rules directly to Oxlint's JavaScript-plugin API: `eslint-plugin-fp@2.3.0` (all 17 rules) and community-maintained `eslint-plugin-bunisms@0.11.0` (all 13 rules). Their names reflect plugin API compatibility, **not an ESLint invocation**. No ESLint configuration, secondary compiler, postinstall hook, nested tooling package or extra lint commands are used. Oxlint is pinned to 1.93.0 because its JS-plugin API is alpha and not covered by semver.

The only explicit ignore remains generated `baml_sdk/**`; dependency directories follow Oxlint defaults. All **25 handwritten TypeScript files**, including **12 test files**, are linted with the same configuration. The test-only `typescript/await-thenable` exemption was removed. No source/test fixes were applied.

## Results

Measured with `bun run lint --format json` on the current working tree:

| Scope | Current errors | Default automatic edits available | Edits preserving the preferred FP style |
| --- | ---: | ---: | ---: |
| Source (13 files) | **1507** | 18 | 16 |
| Tests (12 files) | **1431** | 13 | 2 |
| Total | **2938** | **31** | **18** |

There are **0 warnings**. Automatic-edit counts were measured only in a disposable copy; no fixes were applied to this checkout. They count directly repaired diagnostics, not every diagnostic that disappears as a side effect. The 13-edit difference is explained below.

Baseline: **0 violations** across the same 25 files. The final run reports **265 enabled rules**. Lint exits **1**, intentionally: existing code is not migrated. Counts are emitted diagnostics, not unique lines; overlapping rules can flag the same expression. Zero means an enabled rule found no current violation, not that it was omitted.

The tables explain every added or strengthened rule, plus checks newly exposed by removing the test exemption and ignoring ESLint-style suppressions. Unchanged baseline safety rules remain enabled. Category-based enabling also brings in native import/promise checks; those are listed explicitly below. Categories are ordered by aggregate violations; rules within each category are sorted by total violations descending, with alphabetical ties and zero-violation rules last.

## Functional constraints

Functions and immutable plain data replace classes, receiver state, reassignment, mutation, imperative loops, nil results and throw-based flow. Value-producing composition is preferred over effect-only statements. Normal Bun test registration, assertions, fixtures and cleanup are **not exempt**. Statement-based `if`/`switch` branching remains available for procedural logic; this is not the separate `eslint-plugin-functional` expression-only preset.

| Rule | Why enabled / tightened | Source | Tests | Total |
| --- | --- | ---: | ---: | ---: |
| [`fp/no-unused-expression`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-unused-expression.md) | Require expression results to be used; standalone calls/assertions/test registration are violations. Assignment/update exceptions are independently banned by fp/no-mutation. | 359 | 683 | **1042** |
| [`fp/no-nil`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-nil.md) | Reject nil values outside comparisons, uninitialized bindings, bare returns and block functions without a final return statement. This is syntactic, not control-flow analysis. | 177 | 185 | **362** |
| [`fp/no-throw`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-throw.md) | Require errors as explicit results rather than throw-based control flow. | 80 | 13 | **93** |
| [`fp/no-loops`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-loops.md) | Reject imperative loop statements in favor of value-producing collection composition or recursion. | 55 | 22 | **77** |
| [`fp/no-mutation`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-mutation.md) | Reject assignments and increment/decrement operators; allow no this, CommonJS or property exceptions. | 41 | 31 | **72** |
| [`fp/no-let`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-let.md) | Require const bindings instead of reassigned local state. | 23 | 19 | **42** |
| [`fp/no-mutating-methods`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-mutating-methods.md) | Reject known mutating array/object methods, with no allowed-object exceptions. | 29 | 6 | **35** |
| [`fp/no-rest-parameters`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-rest-parameters.md) | Require fixed, explicit argument contracts rather than variadic rest parameters. | 1 | 2 | **3** |
| [`fp/no-arguments`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-arguments.md) | Require explicit named inputs rather than the implicit arguments object. | 0 | 0 | **0** |
| [`fp/no-class`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-class.md) | Reject class declarations in favor of plain data and functions; the native zero-class limit also covers class expressions. | 0 | 0 | **0** |
| [`fp/no-delete`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-delete.md) | Reject destructive property deletion. | 0 | 0 | **0** |
| [`fp/no-events`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-events.md) | Reject imports of the legacy events module and its hidden event-driven state; this old rule does not recognize node:events. | 0 | 0 | **0** |
| [`fp/no-get-set`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-get-set.md) | Reject getters/setters and matching property-definition APIs that hide effects behind property access. | 0 | 0 | **0** |
| [`fp/no-mutating-assign`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-mutating-assign.md) | Reject Object.assign with a non-fresh destination. | 0 | 0 | **0** |
| [`fp/no-proxy`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-proxy.md) | Reject Proxy construction and its hidden runtime interception behavior. | 0 | 0 | **0** |
| [`fp/no-this`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-this.md) | Reject receiver-dependent behavior and dynamic this state. | 0 | 0 | **0** |
| [`fp/no-valueof-field`](https://github.com/jfmengels/eslint-plugin-fp/blob/5f4c679477a88ac3c386cbfe5c194f3c15d1a2c6/docs/rules/no-valueof-field.md) | Reject custom valueOf fields that hide coercion behavior. | 0 | 0 | **0** |

## Native Oxlint safety, data contracts and module rules

Correctness, suspiciousness and performance diagnostics are errors; warnings fail lint. Type-aware checks use the existing native `oxlint-tsgolint` and project TypeScript 7 setup. Boolean contexts require actual booleans, template interpolation requires strings, Promise handling checks all thenables and does not allow `void` escapes, and type-check suppression directives are banned.

| Rule | Why enabled / tightened | Source | Tests | Total |
| --- | --- | ---: | ---: | ---: |
| [`typescript/explicit-function-return-type`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/explicit-function-return-type.html) | Require explicit result types on every function, including callbacks and higher-order functions. | 163 | 208 | **371** |
| [`typescript/prefer-readonly-parameter-types`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/prefer-readonly-parameter-types.html) | Require deeply readonly inputs, including inferred callback parameters; no method or type exemptions. | 152 | 13 | **165** |
| [`typescript/strict-boolean-expressions`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/strict-boolean-expressions.html) | Require actual booleans; reject truthiness of strings, numbers, objects and nullable values. | 130 | 9 | **139** |
| [`typescript/no-confusing-void-expression`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-confusing-void-expression.html) | Prevent effect-only results from masquerading as values. | 2 | 74 | **76** |
| [`typescript/await-thenable`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/await-thenable.html) | Apply the existing await-only-thenables check to tests too; remove their exemption. | 0 | 63 | **63** |
| [`typescript/restrict-template-expressions`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/restrict-template-expressions.html) | Only interpolate strings; require explicit conversion of every other type. | 52 | 0 | **52** |
| [`no-await-in-loop`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-await-in-loop.html) | Reject statement-based sequential async loops; make async composition explicit. | 30 | 15 | **45** |
| [`typescript/consistent-type-assertions`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/consistent-type-assertions.html) | Ban type casts; prefer checked annotations, narrowing and satisfies (const assertions remain supported). | 38 | 1 | **39** |
| [`typescript/no-unnecessary-condition`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-condition.html) | Remove unreachable/redundant branches, including already-satisfied predicate checks. | 33 | 1 | **34** |
| [`typescript/no-unsafe-type-assertion`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unsafe-type-assertion.html) | Reject assertions that narrow a value without runtime evidence. | 26 | 1 | **27** |
| [`typescript/no-non-null-assertion`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-non-null-assertion.html) | Require actual null checks instead of asserting values exist. | 15 | 10 | **25** |
| [`no-restricted-properties`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-properties.html) | Ban set/add/clear/delete member access on any receiver and direct Promise.reject calls; require immutable collections and explicit error results. Intentionally rejects unrelated APIs with those member names. | 18 | 3 | **21** |
| [`no-plusplus`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-plusplus.html) | Reject increment/decrement mutation, including loop counters. | 9 | 6 | **15** |
| [`typescript/no-unnecessary-type-assertion`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-type-assertion.html) | Reject redundant assertions that obscure the inferred contract. | 11 | 2 | **13** |
| [`typescript/no-unsafe-assignment`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unsafe-assignment.html) | Do not silently assign any-derived data into typed state. | 1 | 8 | **9** |
| [`typescript/use-unknown-in-catch-callback-variable`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/use-unknown-in-catch-callback-variable.html) | Require narrowing Promise rejection values instead of assuming an error shape. | 9 | 0 | **9** |
| [`unicorn/no-array-sort`](https://oxc.rs/docs/guide/usage/linter/rules/unicorn/no-array-sort.html) | Require non-mutating toSorted instead of sort. | 9 | 0 | **9** |
| [`typescript/no-unsafe-member-access`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unsafe-member-access.html) | Validate unknown data before reading its members. | 1 | 7 | **8** |
| [`promise/avoid-new`](https://oxc.rs/docs/guide/usage/linter/rules/promise/avoid-new.html) | Prefer existing Promise-returning APIs over manually managed Promise state. | 1 | 3 | **4** |
| [`promise/prefer-await-to-then`](https://oxc.rs/docs/guide/usage/linter/rules/promise/prefer-await-to-then.html) | Use one explicit async/await control-flow style instead of then/catch/finally chains. | 3 | 1 | **4** |
| [`typescript/no-restricted-types`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-restricted-types.html) | Reject mutable Array/Map/Set/WeakMap/WeakSet/Date named type contracts; use readonly collections or immutable timestamps. Array shorthand T[] is not covered by this rule. | 4 | 0 | **4** |
| [`typescript/no-unsafe-argument`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unsafe-argument.html) | Do not pass any-derived values across function boundaries without validation. | 1 | 3 | **4** |
| [`no-implicit-coercion`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-implicit-coercion.html) | Require explicit conversions rather than coercion tricks. | 3 | 0 | **3** |
| [`promise/prefer-await-to-callbacks`](https://oxc.rs/docs/guide/usage/linter/rules/promise/prefer-await-to-callbacks.html) | Prefer explicit async/await procedures over callback-style async flow. | 2 | 1 | **3** |
| [`no-control-regex`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-control-regex.html) | Retain the existing control-character regex check; ESLint suppression comments no longer bypass Oxlint. | 2 | 0 | **2** |
| [`promise/always-return`](https://oxc.rs/docs/guide/usage/linter/rules/promise/always-return.html) | Make Promise chains produce explicit values rather than silently losing results. | 1 | 1 | **2** |
| [`typescript/explicit-module-boundary-types`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/explicit-module-boundary-types.html) | Require explicit public parameter/result contracts without higher-order or typed-expression exemptions. | 2 | 0 | **2** |
| [`no-param-reassign`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-param-reassign.html) | Protect input bindings and their properties from mutation. | 1 | 0 | **1** |
| [`no-void`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-void.html) | Do not discard expression or Promise results with void. | 1 | 0 | **1** |
| [`typescript/no-floating-promises`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-floating-promises.html) | Check all thenables and disallow void as a way to hide unhandled async work. | 1 | 0 | **1** |
| [`typescript/no-import-type-side-effects`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-import-type-side-effects.html) | Do not accidentally retain runtime side effects in type-only imports. | 1 | 0 | **1** |
| [`typescript/return-await`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/return-await.html) | Make Promise-returning control flow and local error propagation explicit with return await. | 1 | 0 | **1** |
| [`typescript/strict-void-return`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/strict-void-return.html) | Do not silently discard non-void callback results behind void-returning signatures. | 0 | 1 | **1** |
| [`unicorn/consistent-function-scoping`](https://oxc.rs/docs/guide/usage/linter/rules/unicorn/consistent-function-scoping.html) | Hoist independent functions so their real dependencies and closure capture are visible. | 0 | 1 | **1** |
| [`unicorn/no-array-reverse`](https://oxc.rs/docs/guide/usage/linter/rules/unicorn/no-array-reverse.html) | Require non-mutating toReversed instead of reverse. | 0 | 1 | **1** |
| [`array-callback-return`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/array-callback-return.html) | Require value-producing collection callbacks to return and reject misleading forEach returns. | 0 | 0 | **0** |
| [`import/default`](https://oxc.rs/docs/guide/usage/linter/rules/import/default.html) | Verify referenced default exports exist where statically resolvable. | 0 | 0 | **0** |
| [`import/namespace`](https://oxc.rs/docs/guide/usage/linter/rules/import/namespace.html) | Validate namespace import member access where statically resolvable. | 0 | 0 | **0** |
| [`import/no-absolute-path`](https://oxc.rs/docs/guide/usage/linter/rules/import/no-absolute-path.html) | Keep module dependencies portable instead of machine-specific absolute imports. | 0 | 0 | **0** |
| [`import/no-commonjs`](https://oxc.rs/docs/guide/usage/linter/rules/import/no-commonjs.html) | Enforce a single ESM module system. | 0 | 0 | **0** |
| [`import/no-cycle`](https://oxc.rs/docs/guide/usage/linter/rules/import/no-cycle.html) | Keep function/data modules acyclic and dependency direction explicit. | 0 | 0 | **0** |
| [`import/no-default-export`](https://oxc.rs/docs/guide/usage/linter/rules/import/no-default-export.html) | Require named exports so function/data interfaces are explicit. | 0 | 0 | **0** |
| [`import/no-empty-named-blocks`](https://oxc.rs/docs/guide/usage/linter/rules/import/no-empty-named-blocks.html) | Reject empty import/export blocks that hide ineffective dependencies. | 0 | 0 | **0** |
| [`import/no-mutable-exports`](https://oxc.rs/docs/guide/usage/linter/rules/import/no-mutable-exports.html) | Do not expose reassigned module-level state. | 0 | 0 | **0** |
| [`import/no-named-as-default`](https://oxc.rs/docs/guide/usage/linter/rules/import/no-named-as-default.html) | Avoid confusing named exports with the module default. | 0 | 0 | **0** |
| [`import/no-named-as-default-member`](https://oxc.rs/docs/guide/usage/linter/rules/import/no-named-as-default-member.html) | Avoid treating default exports as containers for named exports. | 0 | 0 | **0** |
| [`import/no-self-import`](https://oxc.rs/docs/guide/usage/linter/rules/import/no-self-import.html) | Reject modules importing themselves. | 0 | 0 | **0** |
| [`import/no-unassigned-import`](https://oxc.rs/docs/guide/usage/linter/rules/import/no-unassigned-import.html) | Reject implicit module-initialization side effects from bare imports. | 0 | 0 | **0** |
| [`max-classes-per-file`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-classes-per-file.html) | Set the maximum to zero, including class expressions, closing fp/no-class's declaration-only coverage gap. | 0 | 0 | **0** |
| [`no-restricted-imports`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-imports.html) | Ban both events and node:events imports so the legacy FP plugin cannot miss Node-prefixed event-emitter dependencies. | 0 | 0 | **0** |
| [`no-return-assign`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-return-assign.html) | Keep returned values separate from state-changing assignments. | 0 | 0 | **0** |
| [`no-useless-call`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-useless-call.html) | Remove unnecessary call/apply indirection; performance checks are now errors. | 0 | 0 | **0** |
| [`no-var`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-var.html) | Eliminate function-scoped mutable bindings. | 0 | 0 | **0** |
| [`object-shorthand`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/object-shorthand.html) | Keep plain-data construction explicit and concise without redundant property bindings. | 0 | 0 | **0** |
| [`oxc/no-accumulating-spread`](https://oxc.rs/docs/guide/usage/linter/rules/oxc/no-accumulating-spread.html) | Reject quadratic copying in collection accumulation; use efficient immutable transformations. | 0 | 0 | **0** |
| [`oxc/no-map-spread`](https://oxc.rs/docs/guide/usage/linter/rules/oxc/no-map-spread.html) | Reject redundant copying around map results; performance checks are now errors. | 0 | 0 | **0** |
| [`prefer-arrow-callback`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/prefer-arrow-callback.html) | Use lexical callbacks without dynamic this, with no named-function exception. | 0 | 0 | **0** |
| [`prefer-const`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/prefer-const.html) | Require immutable bindings whenever reassignment is unnecessary. | 0 | 0 | **0** |
| [`prefer-object-spread`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/prefer-object-spread.html) | Prefer declarative object composition over Object.assign calls. | 0 | 0 | **0** |
| [`prefer-spread`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/prefer-spread.html) | Prefer explicit spread invocation over apply-based calls. | 0 | 0 | **0** |
| [`promise/no-callback-in-promise`](https://oxc.rs/docs/guide/usage/linter/rules/promise/no-callback-in-promise.html) | Do not mix callback control flow into Promise chains. | 0 | 0 | **0** |
| [`promise/no-multiple-resolved`](https://oxc.rs/docs/guide/usage/linter/rules/promise/no-multiple-resolved.html) | Reject multiple resolve/reject paths that depend on settlement timing. | 0 | 0 | **0** |
| [`promise/no-new-statics`](https://oxc.rs/docs/guide/usage/linter/rules/promise/no-new-statics.html) | Do not construct Promise static methods. | 0 | 0 | **0** |
| [`promise/no-promise-in-callback`](https://oxc.rs/docs/guide/usage/linter/rules/promise/no-promise-in-callback.html) | Do not mix Promise control flow into callback APIs. | 0 | 0 | **0** |
| [`promise/valid-params`](https://oxc.rs/docs/guide/usage/linter/rules/promise/valid-params.html) | Validate Promise API arity and callback arguments. | 0 | 0 | **0** |
| [`typescript/ban-ts-comment`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/ban-ts-comment.html) | Ban ts-ignore, ts-nocheck and ts-expect-error escape hatches; ts-check remains allowed because it adds checking. | 0 | 0 | **0** |
| [`typescript/consistent-type-definitions`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/consistent-type-definitions.html) | Use plain type aliases rather than extensible interfaces. | 0 | 0 | **0** |
| [`typescript/consistent-type-exports`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/consistent-type-exports.html) | Mark type-only exports explicitly so the runtime interface stays clear. | 0 | 0 | **0** |
| [`typescript/consistent-type-imports`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/consistent-type-imports.html) | Separate type dependencies from runtime dependencies. | 0 | 0 | **0** |
| [`typescript/method-signature-style`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/method-signature-style.html) | Describe callable data properties rather than OO method signatures. | 0 | 0 | **0** |
| [`typescript/no-deprecated`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-deprecated.html) | Reject deprecated APIs rather than carrying legacy runtime behavior forward. | 0 | 0 | **0** |
| [`typescript/no-dynamic-delete`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-dynamic-delete.html) | Reject dynamic property deletion from data objects. | 0 | 0 | **0** |
| [`typescript/no-invalid-void-type`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-invalid-void-type.html) | Restrict void to legitimate result positions rather than data models. | 0 | 0 | **0** |
| [`typescript/no-namespace`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-namespace.html) | Prefer ESM functions/data over TypeScript namespace containers. | 0 | 0 | **0** |
| [`typescript/no-require-imports`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-require-imports.html) | Reject require imports in favor of statically expressed ESM dependencies. | 0 | 0 | **0** |
| [`typescript/no-unsafe-call`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unsafe-call.html) | Do not call unchecked any-derived values. | 0 | 0 | **0** |
| [`typescript/no-unsafe-return`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unsafe-return.html) | Do not leak any-derived values through function results. | 0 | 0 | **0** |
| [`typescript/prefer-function-type`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/prefer-function-type.html) | Represent callable interfaces directly as function types. | 0 | 0 | **0** |
| [`typescript/restrict-plus-operands`](https://oxc.rs/docs/guide/usage/linter/rules/typescript/restrict-plus-operands.html) | Only combine compatible strings or numbers; disable permissive coercion allowances. | 0 | 0 | **0** |
| [`unicorn/no-array-for-each`](https://oxc.rs/docs/guide/usage/linter/rules/unicorn/no-array-for-each.html) | Reject effect-only array iteration; favor value-producing collection composition. | 0 | 0 | **0** |
| [`unicorn/no-array-method-this-argument`](https://oxc.rs/docs/guide/usage/linter/rules/unicorn/no-array-method-this-argument.html) | Reject dynamic this binding in collection callbacks. | 0 | 0 | **0** |
| [`unicorn/no-immediate-mutation`](https://oxc.rs/docs/guide/usage/linter/rules/unicorn/no-immediate-mutation.html) | Do not mutate freshly created collection values as a separate construction step. | 0 | 0 | **0** |
| [`unicorn/no-this-assignment`](https://oxc.rs/docs/guide/usage/linter/rules/unicorn/no-this-assignment.html) | Do not smuggle dynamic this into closure state through aliases. | 0 | 0 | **0** |
| [`unicorn/prefer-array-find`](https://oxc.rs/docs/guide/usage/linter/rules/unicorn/prefer-array-find.html) | Use direct find operations instead of filtering an entire collection for one result. | 0 | 0 | **0** |
| [`unicorn/prefer-array-flat-map`](https://oxc.rs/docs/guide/usage/linter/rules/unicorn/prefer-array-flat-map.html) | Use direct flatMap composition instead of map followed by flattening. | 0 | 0 | **0** |
| [`unicorn/prefer-set-has`](https://oxc.rs/docs/guide/usage/linter/rules/unicorn/prefer-set-has.html) | Use explicit set membership where repeated collection membership merits it. | 0 | 0 | **0** |

## Bun-specific rules

All Bunisms strict/all rules are promoted from their preset's warning severity to **errors**. These rules recognize particular API patterns; they do not blanket-ban Node compatibility APIs. The mock rules apply to tests without overrides.

| Rule | Why enabled / tightened | Source | Tests | Total |
| --- | --- | ---: | ---: | ---: |
| [`bun/prefer-bun-write`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-bun-write.md) | Prefer Bun.write for recognized asynchronous Node file writes. | 7 | 31 | **38** |
| [`bun/prefer-bun-file`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-bun-file.md) | Prefer Bun.file for recognized asynchronous Node file reads; deliberately does not flag synchronous reads. | 5 | 6 | **11** |
| [`bun/prefer-bun-crypto-hasher`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-bun-crypto-hasher.md) | Prefer Bun hashing APIs over recognized Node crypto hash patterns. | 5 | 0 | **5** |
| [`bun/prefer-import-meta-dir`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-import-meta-dir.md) | Prefer import.meta.dir over recognized directory-name shims. | 1 | 0 | **1** |
| [`bun/prefer-import-meta-path`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-import-meta-path.md) | Prefer import.meta.path over recognized filename conversion shims. | 1 | 0 | **1** |
| [`bun/no-dotenv`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/no-dotenv.md) | Prefer Bun environment handling over adding dotenv. This project disables automatic loading in doctor, so any future dotenv use would require an explicit runtime-policy decision. | 0 | 0 | **0** |
| [`bun/no-late-module-mock`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/no-late-module-mock.md) | Ensure mock.module registration precedes affected static imports so mocks actually take effect. | 0 | 0 | **0** |
| [`bun/prefer-bun-shell`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-bun-shell.md) | Prefer Bun Shell over recognized shell-command execution patterns. | 0 | 0 | **0** |
| [`bun/prefer-bun-spawn`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-bun-spawn.md) | Prefer Bun subprocess APIs over recognized Node child_process operations. | 0 | 0 | **0** |
| [`bun/prefer-fetch`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-fetch.md) | Prefer fetch over recognized Node HTTP client request APIs. | 0 | 0 | **0** |
| [`bun/prefer-import-meta-main`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-import-meta-main.md) | Prefer import.meta.main over recognized entry-point detection shims. | 0 | 0 | **0** |
| [`bun/prefer-import-meta-resolve`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-import-meta-resolve.md) | Prefer import.meta.resolve over recognized CommonJS resolver shims. | 0 | 0 | **0** |
| [`bun/prefer-mock-restore-in-after-each`](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/docs/rules/prefer-mock-restore-in-after-each.md) | Require recognized mock cleanup in afterEach so state cannot leak between tests. | 0 | 0 | **0** |

## Conflicting rules and pending precedence decisions

**Preferred direction: Bunisms and the stronger functional style over competing convenience, redundancy or imperative-rewrite advice.** The rules remain enabled so their costs stay visible while precedence is decided later. No rule was disabled and no test exemption was added. Where Bunisms and functional constraints conflict with each other, neither has silently been declared the winner.

Counts below are each rule's **current project-wide error total**, including tests. They are **not counts of proven conflicting sites** and must not be added together: the same rule appears in multiple rows, and alternative forms of the same code can trigger different rules. A zero-error rule can still recommend a future rewrite that violates another enabled rule.

| Rules and current error counts | Conflict or tension | Preferred direction / decision still needed |
| --- | --- | --- |
| `fp/no-unused-expression`: **1042** ↔ `typescript/no-confusing-void-expression`: **76**; compounded by `fp/no-nil`: **362** | **Direct void-call conflict.** `mock.restore();` is an unused expression; `return mock.restore()` and assigning its result are confusing void expressions. A block without a final value return also violates `no-nil`. The default autofixer changes 13 concise void callbacks into blocks, introducing **13 unused-expression + 13 no-nil errors**. | Preserve the stronger FP constraints rather than automatically applying the competing void-expression rewrite. The valid representation of effectful boundaries still needs a decision. |
| `bun/prefer-mock-restore-in-after-each`: **0** ↔ `fp/no-unused-expression`: **1042**, `fp/no-nil`: **362**, `typescript/no-confusing-void-expression`: **76** | **Bunisms/FP boundary conflict.** Bunisms recognizes direct restore calls inside an `afterEach` callback. Its documented `afterEach(() => mock.restore())` form meets the cleanup rule but conflicts with the void rules above; switching to a bare block statement does not satisfy FP. Passing `afterEach(mock.restore)` is not recognized as hook cleanup by this Bunisms implementation. | Both Bunisms and stronger FP are preferred. Their relative precedence is **unresolved**; do not disable the Bun cleanup rule or exempt tests as an implicit workaround. The zero Bunisms count means no current cleanup diagnostic, not that its documented idiom is compatible. |
| `fp/no-nil`: **362** ↔ `no-unreachable`: **0** | **Syntactic false positive / rewrite trap.** An exhaustive `if/else` with a return in each branch ends in an `IfStatement`, so `no-nil` complains. Appending a final return creates unreachable code. | Prefer a value expression or flatten the branches to a final return. Stronger functional structure does **not** justify adding unreachable code. Decide later whether the legacy `no-nil` heuristic is worth retaining. |
| `typescript/strict-boolean-expressions`: **139** ↔ `no-extra-boolean-cast`: **0** | **Local fix conflict.** `if (Boolean(nullableString))` is flagged as an extra cast; removing `Boolean` makes the nullable-string condition violate strict boolean checking. Binding the conversion first or testing null/empty cases explicitly satisfies both. | Prefer explicit, strictly boolean conditions over redundant-cast advice. The category-enabled `no-extra-boolean-cast` is the lower-priority candidate; it remains enabled pending the decision. |
| `fp/no-throw`: **93** ↔ `oxc/missing-throw`: **0** | **Contradictory advice, not an unsatisfiable policy.** A discarded `new Error(...)` prompts `missing-throw` to suggest `throw`, which FP forbids. Returning an error value satisfies both. | Prefer explicit error results and the FP throw ban over `missing-throw` advice. The latter remains enabled for the later precedence decision. |
| `fp/no-loops`: **77** ↔ `unicorn/no-array-for-each`: **0** | **Contradictory advice.** The native rule recommends replacing `forEach` with `for…of`; the FP rule rejects that replacement. Value-producing collection composition can satisfy both. | Prefer the loop ban; do not apply a loop rewrite merely to remove a `forEach` error. |
| `fp/no-mutation`: **72**, `fp/no-mutating-methods`: **35** ↔ `oxc/no-accumulating-spread`: **0**, `oxc/no-map-spread`: **0** | **Conditional performance-advice tension, not a hard conflict.** Suggestions involving `.push()`, assignments or mutating `Object.assign` conflict with FP. Non-mutating alternatives such as `.concat()` or different collection construction may remain compatible. | Prefer immutable transformations over mutation-based optimization suggestions; review performance separately rather than weakening FP automatically. |

These findings do **not** mean every program is unsatisfiable. Some are incompatible local representations or conflicting advice, rather than unconditional opposing requirements. Overlapping checks such as `no-explicit-any` plus `no-unsafe-*`, and the compiler's `strict` settings, are compatible. An explicitly typed Promise returned with `return await` also passed the compatibility probe.

## Automatic-fix preview — no project fixes applied

Oxlint 1.93.0 has no advertised CLI dry-run flag. A disposable copy of the 25 source/test files was used instead. Its initial diagnostics matched the live checkout **exactly**, including locations and messages. Only the copied `scripts/` directory was eligible for modification. Dependency/generated-code links were not fix targets. Neither suggestion fixes nor dangerous fixes were requested.

### Available default fixes by rule

| Rule | Current errors | Direct default automatic edits | Edits preserving preferred FP style |
| --- | ---: | ---: | ---: |
| `typescript/no-confusing-void-expression` | 76 | **13** | **0** — these rewrites introduce FP errors |
| `typescript/no-unnecessary-type-assertion` | 13 | **13** | **13** |
| `no-implicit-coercion` | 3 | **3** | **3** |
| `typescript/no-import-type-side-effects` | 1 | **1** | **1** |
| `typescript/return-await` | 1 | **1** | **1** |
| **Total** | — | **31** | **18** |

These are **observed fixable occurrences**, not every error belonging to a rule whose metadata advertises a fixer. Other current errors, including all current FP and Bunisms errors, received **no direct default fix** in this preview. Some rules offer suggestions or conditional fixes that are not included by the existing `lint:fix` command; those are deliberately not counted as default automatic edits.

### Fresh lint after each isolated preview

| Isolated scenario | Source errors | Test errors | Total errors | Net reduction |
| --- | ---: | ---: | ---: | ---: |
| Unmodified baseline | 1507 | 1431 | **2938** | — |
| Default `--fix` | 1479 | 1438 | **2917** | **21** |
| FP-first preview: defer only the void-expression fixer | 1477 | 1427 | **2904** | **34** |

- **Default preview:** 31 directly repaired diagnostics plus **16 collateral removals** (11 assertion-style, 2 non-null-assertion, 3 strict-boolean errors), minus **26 newly introduced FP errors**, yields a net reduction of **21**. In particular, test errors **increase by 7** despite the lower overall total.
- **FP-first preview:** the competing void-expression rule was allowed only during the **temporary fix invocation** to defer its 13 rewrites. The subsequent lint used the **full original configuration**, with that rule re-enabled. The 18 remaining edits removed 18 direct + 16 collateral diagnostics, with no new diagnostic-count increases: **34 fewer errors**. This is evidence for the preferred direction, **not a configuration change or a final precedence decision**.
- The 13 void-callback rewrites are mechanically available but conflict with the requested stronger FP style. **Do not treat all 31 default edits as policy-compatible.** “FP-compatible” here means no newly introduced lint diagnostics in this measured preview, not proof of preserved application behavior.
- The project's source/test file hashes were checked before and after: **unchanged**. No application tests were run against the temporary rewritten code, and no rewritten files were copied back. Both preview scenarios still fail lint.

## Enforcement and limitations

- `max-classes-per-file` is **0**, with class expressions included. This closes the old FP plugin's class-declaration-only check.
- Known collection mutators `set`, `add`, `clear`, `delete` are forbidden on every receiver. This intentionally catches unrelated APIs with these member names too. No mutable-collection exceptions are provided.
- `fp/no-nil` allows null/undefined comparisons, but also syntactically requires a final return in block functions; it may flag a function whose branches already return. That strict legacy behavior is intentional.
- `respectEslintDisableDirectives: false` prevents existing ESLint suppression comments from weakening native checks. Unused native disable directives are errors. Oxlint's own supported disable directives still exist; there are no test-specific suppressions in configuration.
- This is **not proof of semantic purity or complete deep immutability**: aliases, arbitrary third-party mutators, hidden effects, inferred result types and all possible throw/reject paths cannot be proven away by these rules. Native readonly-parameter checks cover deep input contracts; named mutable types are banned, but mutable `T[]` result/variable syntax is not globally prohibited.
- Full typed `eslint-plugin-functional` rules need TypeScript parser services that Oxlint's JS-plugin API does not provide. They were not installed or falsely claimed to work. No second linter was added to fill that gap.
- `eslint-plugin-fp` is old and syntax-oriented. Its `no-events` rule recognizes the legacy `events` module spelling; native `no-restricted-imports` additionally bans `node:events`. Its method checks are name-based rather than type-aware.
- Autofix was **not applied to this checkout**; only the disposable previews above were run. In particular, sequential media operations must not be blindly parallelized merely to silence `no-await-in-loop`. Current lint failures document the requested strict policy; they are not authorization to change runtime semantics.

## Verification

- Ran the original `bun run lint` command with JSON output; all diagnostics have rule codes and file paths, and no configuration/plugin loading errors occurred.
- Verified all 17 FP and 13 Bun rules are configured as errors.
- Rechecked current errors and recorded each conflicting rule's total separately from measured automatic-edit counts. Kept all conflicting rules enabled for the later precedence decision.
- Compared a matching disposable baseline, a default-fix preview and an FP-first preview; reran the complete original policy after both previews and verified the project's source/test hashes stayed unchanged.
- A temporary `.test.ts` probe confirmed mutation, loops, throws, readonly parameters, class expressions, collection mutators and Bun read/write preferences fire inside test files. The probe was removed before measuring counts.
- Application tests were not executed: no application code changed, and the requested strict lint gate deliberately fails existing code.

## Primary sources

- [Oxlint JS-plugin support and limitations](https://oxc.rs/docs/guide/usage/linter/js-plugins.html): runtime compatibility API, alpha status and lack of TypeScript parser services.
- [Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html): native tsgolint integration.
- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config.html) and the installed 1.93.0 configuration schema: categories, options and supported rule settings. Each native table entry links to its rule documentation.
- [FP plugin rule inventory](https://github.com/jfmengels/eslint-plugin-fp) and [published 2.3.0 metadata](https://registry.npmjs.org/eslint-plugin-fp/2.3.0). Rule behavior was checked against installed source, especially `no-class`, `no-nil`, `no-mutation` and `no-unused-expression`.
- [Bunisms documentation and Oxlint compatibility](https://github.com/himynameisdave/eslint-plugin-bunisms), [exact rule/preset definitions for 0.11.0](https://github.com/himynameisdave/eslint-plugin-bunisms/blob/7c9db1ac16d56f2b2cc971f0446db520a85b8f38/src/index.ts), and [published package metadata](https://registry.npmjs.org/eslint-plugin-bunisms/0.11.0). This is community-maintained, not an official Oven plugin.
