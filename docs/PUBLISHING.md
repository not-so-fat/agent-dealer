# Publishing agent-dealer

> **Cursor:** release steps in `.cursor/rules/agent-dealer-release.mdc`.

## How releases work today

**Ship via git only.** There is no installable npm package for the app.

| Surface | What |
|---------|------|
| **Git tag** `vX.Y.Z` + **GitHub Release** | Real product — clone, checkout tag, `npm ci`, `npm run build` |
| **npm `agent-dealer@0.0.0`** | One-time **name reservation** only (~792 B). Do **not** bump or republish empty tarballs for app releases. |

The monorepo root is `"private": true`. Nothing in this repo is set up for `npm install agent-dealer` to run the dashboard.

**Using a release:**

```bash
git clone https://github.com/not-so-fat/agent-dealer.git
cd agent-dealer
git checkout v0.1.0
npm ci && npm run build
npm run dev    # dev — see README
# or prod — docs/PROD_SETUP.md
```

## Release order

1. Agree version with human (`X.Y.Z`).
2. `npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`
3. `CHANGELOG.md` section for `X.Y.Z`
4. Gates: `npm run build`, `npm run flow:verify` (and `poc:integration` when integrations changed)
5. Commit: `Ship X.Y.Z: <why>.`
6. Tag: `git tag -a vX.Y.Z -m "agent-dealer X.Y.Z"`
7. Push: `git push origin main && git push origin vX.Y.Z`
8. GitHub: `gh release create vX.Y.Z --title "X.Y.Z" --notes-file .temporal/logs/release-notes-X.Y.Z.md`

## Future: real npm install

Only when there is an actual install path (e.g. CLI + bundled server like Agent Deck, or scoped `@agent-dealer/*` packages with `bin` and `files`). Empty README-only publishes are **not** releases — they waste registry versions and lie to `npm install`.
