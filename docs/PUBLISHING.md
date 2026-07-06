# Publishing agent-dealer

> **Cursor:** `.cursor/rules/agent-dealer-release.mdc`

## npm package

| npm package | Purpose |
|-------------|---------|
| `agent-dealer` | CLI (`setup`, `start`, `doctor`) + bundled `@agent-dealer/server` and `@agent-dealer/shared` |

One install — no scoped org required on npm.

## Friend install path

```bash
npm install -g agent-dealer
agent-dealer setup
agent-dealer start --open
```

Dashboard + API: **http://localhost:2221** (single port when UI is bundled).

## Prerequisites (publisher)

- Node.js 20+
- `npm login` (+ `--otp=…` when 2FA prompts)
- `gh` for GitHub releases

## Release order

1. Agree version with human (`X.Y.Z`).
2. `npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`
3. Sync `packages/cli/package.json` dependency `"@agent-dealer/server": "X.Y.Z"`.
4. `CHANGELOG.md` section for `X.Y.Z`.
5. `npm run build:release` — builds all workspaces + copies web dist → `packages/server/static-ui`.
6. `npm run install:smoke` — pack + fresh install test (must pass before publish).
7. Gates: `npm run flow:verify` when API changes need it.
8. Commit: `Ship X.Y.Z: <why>.`
9. Tag + push + `gh release create`.
10. `npm run publish:packages` — stages self-contained tarball then publishes `agent-dealer` (human logged in).

## Dev monorepo

Repo root stays `"private": true`. Use `npm run dev` from a git checkout.
