# Publishing agent-dealer

> **Cursor:** release steps in `.cursor/rules/agent-dealer-release.mdc`.

## Two surfaces

| Surface | Version | Purpose |
|---------|---------|---------|
| **Git** (`vX.Y.Z` tag, GitHub Release) | Matches repo `package.json` | Real product — clone, `npm ci`, `npm run build` |
| **npm** `agent-dealer` | Same semver as git | Registry pointer + changelog discoverability; not a full app tarball |

The monorepo root is `"private": true` — do not `npm publish` from the repo root.

## Prerequisites

- Node.js 20+
- `gh` for GitHub releases
- npm account **`not-so-fat`** with publish access to `agent-dealer`
- **Human:** `npm login` (and `--otp=…` when 2FA prompts)

## Release order

1. Agree version with human (`X.Y.Z`).
2. `npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`
3. `CHANGELOG.md` section for `X.Y.Z`
4. Gates: `npm run build`, `npm run flow:verify` (and `poc:integration` when integrations changed)
5. Bump `scripts/npm-package/package.json` to `X.Y.Z`; sync `scripts/npm-package/README.md` checkout line
6. Commit: `Ship X.Y.Z: <why>.`
7. Tag: `git tag -a vX.Y.Z -m "agent-dealer X.Y.Z"`
8. Push: `git push origin main && git push origin vX.Y.Z`
9. GitHub: `gh release create vX.Y.Z --title "X.Y.Z" --notes-file .temporal/logs/release-notes-X.Y.Z.md`
10. npm (human logged in): `npm publish --access public` from `scripts/npm-package/` (add `--otp=…` if needed)

Verify: `npm view agent-dealer version` should match `X.Y.Z`.
