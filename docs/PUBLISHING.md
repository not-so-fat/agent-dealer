# Publishing agent-dealer

> **Cursor:** `.cursor/rules/agent-dealer-release.mdc`

## npm package

| npm package | Purpose |
|-------------|---------|
| `agent-dealer` | CLI (`setup`, `start`, `doctor`) + bundled `@agent-dealer/server` and `@agent-dealer/shared` |

One install — no scoped org required on npm.

## Friend install path

**Recommended (managed — auto-updates; existing `~/.agent-dealer` data kept):**

```bash
curl -fsSL https://raw.githubusercontent.com/not-so-fat/agent-dealer/main/scripts/install.sh | bash
# or: npx agent-dealer@latest install
export PATH="$HOME/.local/bin:$PATH"
agent-dealer setup
agent-dealer start --open
```

Compat: `npm install -g agent-dealer` still works.

| Command / env | Behavior |
|---------------|----------|
| `agent-dealer install` | Versions under `~/.agent-dealer/versions/` + `~/.local/bin/agent-dealer` |
| `agent-dealer upgrade` | Managed activate or npm-global reinstall |
| `AGENT_DEALER_DISABLE_AUTOUPDATER=1` | Disable background managed updates |

Dashboard + API: **http://localhost:2222** (single port when UI is bundled).

## Prerequisites (publisher)

- Node.js 20+
- `npm login` (+ `--otp=…` when 2FA prompts)
- `gh` for GitHub releases

## Release order

One command per phase; the scripts own every mechanical step (`scripts/release.mjs`).

1. From a clean, up-to-date `main`: `npm run release:prepare -- <patch|minor|major|X.Y.Z> --summary "<one line why>"`
   bumps every manifest, internal pin and the lockfile, stubs the CHANGELOG from `git log vPREV..HEAD`, runs `build:release` + `install:smoke`, commits `Ship X.Y.Z: <why>` and opens the PR.
2. Edit the CHANGELOG stub in the PR if the bullets need rewording (the bump level and summary are the only judgment calls).
3. From the `release/X.Y.Z` branch: `npm run release:finish` waits for CI, squash-merges, tags `vX.Y.Z` and runs `gh release create`.
4. **Human:** `npm run publish:packages -- --otp=CODE` (stages and publishes from `.temporal/npm-stage/agent-dealer`).

CI runs `npm run release:check`, which fails on any version, internal-pin or lockfile drift.

## Dev monorepo

Repo root stays `"private": true`. Use `npm run dev` from a git checkout.

## Publish command (important)

```bash
npm run publish:packages              # stages + cd into stage dir + npm publish
npm run publish:packages -- --otp=… # 2FA
```

**Never** `npm publish` from repo root — `EPRIVATE` (root is `private: true`, same package name).

Implementation: `scripts/stage-npm-package.mjs` → `.temporal/npm-stage/agent-dealer` → `scripts/publish-npm.sh`.
