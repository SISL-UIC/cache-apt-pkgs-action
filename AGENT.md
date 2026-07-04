# Agent Rules

This file defines high-priority implementation and documentation rules for coding agents.

## Always Apply

1. Prefer minimal, reversible changes.
2. Preserve behavior unless explicitly requested to change it.
3. Do not claim verification succeeded unless commands were run.
4. Report exact verification commands and pass/fail outcomes.

## Documentation Rules

For changes in `src/`, apply these rules to exported/public APIs:

1. Use TSDoc (`/** ... */`) with a short behavior-focused summary.
2. Add explicit `@param` tags for each parameter.
3. Add explicit `@returns` tags.
4. Add `@throws` for intentional thrown errors.
5. Update docs in the same change as the behavior change.
6. Avoid repeating obvious implementation detail.

## Testing Rules

1. Add or update tests in the same change when behavior changes.
2. Run targeted tests first, then broader suites as needed.
3. Keep test naming in `<method> <conditions> <expected>` format.

## Minimum Verification

```bash
npm run typecheck
npm exec vitest run test/action.test.ts test/action-runner.test.ts test/manifest.test.ts test/io.test.ts
```

When changing scripts:

```bash
npm exec vitest run test/dev_scripts.test.ts
```
