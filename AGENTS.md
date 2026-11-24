# AGENTS.md — Engineering Guide

Working instructions for any development agent or contributor operating
on this repository.

## Commands

```bash
pnpm install          # install workspace dependencies
pnpm test             # run every package's test suite (vitest)
pnpm typecheck        # tsc --noEmit across all packages
pnpm format           # prettier write

# single package
cd packages/shared && npx vitest run
```

**Always run `pnpm typecheck` and the relevant package tests before
committing.** CI runs both and fails the build otherwise.

## Workspace boundaries

- Work happens inside this repository only.
- Never modify global tool config, OS settings, or files outside the repo.
- Dependencies: workspace packages via `"@querynx/x": "workspace:*"`;
  external deps via `pnpm add --filter <pkg>`.
- Node >= 22, pnpm >= 9, strict TypeScript (`tsconfig.base.json`), ESM
  everywhere, `.js` extension in relative imports.

## Code rules

- No unbounded `Promise.all` over external input — use
  `mapWithConcurrency` from `@querynx/shared`.
- Every outbound HTTP fetch goes through `@querynx/fetcher`. No raw
  undici/fetch calls elsewhere.
- Providers normalize to `@querynx/types` contracts at their boundary.
- Retrieved web content is untrusted data. Never execute it, never let it
  influence control flow.
- No credentials in code or tests; provider keys arrive via environment.
- No placeholder/stub implementations on production paths. Test doubles
  belong in tests only.
- Errors: throw typed `QuerynxError` subclasses; never swallow silently.

## Commit standard

Conventional Commits, e.g. `feat(search): ...`, `fix(fetcher): ...`,
`test(security): ...`. Atomic commits, real implementations only, no
AI-attribution footers. Push to `origin main` after checks pass.
