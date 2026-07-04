# Contributions

Thank you for contributing to this project.

## Scope

This document defines contribution expectations for code quality, testing, and documentation.

## Quick Start

1. Fork and create a feature branch from `v2-ts`.
2. Make focused, minimal, reversible changes.
3. Run relevant checks before opening a PR.
4. Open a PR with a clear summary and validation notes.

## Development Standards

1. Preserve existing architecture unless a change is explicitly requested.
2. Keep naming consistent for semantically identical constructs.
3. Prefer explicit failures with actionable errors.
4. Avoid changing public API or externally observable behavior unless requested.

## Documentation Standards

Apply these standards to all exported/public APIs in `src/`:

1. Use TSDoc blocks (`/** ... */`) with concise behavior-focused summaries.
2. Include explicit `@param` tags for each input parameter.
3. Include explicit `@returns` tags for return values (or `Nothing` for `void`).
4. Include `@throws` when the function intentionally throws validation/runtime errors.
5. Prefer documenting behavior and constraints over implementation detail.
6. Keep comments synchronized with current behavior; update docs in the same change as code.

## Testing Standards

1. Test naming format: `<method> <conditions> <expected>`.
2. Test behavior, not implementation detail.
3. Keep setup focused on the tested condition.
4. Avoid control-flow logic (`if`, loops) in test bodies.
5. Add or update tests for any behavior change in the same PR.

## Verification Before PR

Run the smallest relevant checks first, then broader checks as needed:

```bash
npm run typecheck
npm exec vitest run test/action.test.ts test/action-runner.test.ts test/manifest.test.ts test/io.test.ts
```

When changing scripts under `scripts/dev/` or `scripts/ops/`, also run:

```bash
npm exec vitest run test/dev_scripts.test.ts
```

## Pull Request Checklist

1. Change scope is clear and minimal.
2. Documentation updated for exported/public API changes.
3. Tests added/updated for behavior changes.
4. Verification commands listed with pass/fail status.
5. No secrets or credentials are included.

## Commit Message Guidance

Use concise, imperative messages, for example:

- `docs: standardize TSDoc across src APIs`
- `test: add coverage for ActionRunner cache-hit branch`
- `refactor: move reusable script library to repository root`
