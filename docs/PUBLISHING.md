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

## Prerequisites (agent)

- Node.js 22+
- `gh` for watching the release workflow
- No `npm login`, no OTP: a normal release never touches npm credentials. Publishing
  happens in GitHub Actions with npm trusted publishing (OIDC).

## Release order

One command per phase; the scripts own every mechanical step (`scripts/release.mjs`).
The owner's release request is the only human step.

1. From a clean, up-to-date `main`: `npm run release:prepare -- <patch|minor|major|X.Y.Z> --summary "<one line why>"`
   bumps every manifest, internal pin and the lockfile, stubs the CHANGELOG from `git log vPREV..HEAD`, runs `build:release` + `install:smoke`, commits `Ship X.Y.Z: <why>` and opens the PR.
2. Edit the CHANGELOG stub in the PR if the bullets need rewording (the bump level and summary are the only judgment calls).
3. From the `release/X.Y.Z` branch: `npm run release:finish` waits for CI, squash-merges and pushes the `vX.Y.Z` tag.
4. The agent watches `.github/workflows/release.yml` (triggered by the tag push) to the end:
   it guards (tag == version, commit on `main`, CHANGELOG section), publishes `agent-dealer@X.Y.Z`
   to npm with provenance, then creates the GitHub Release from the CHANGELOG section.
   Confirm with `npm view agent-dealer@X.Y.Z version`.

CI runs `npm run release:check`, which fails on any version, internal-pin or lockfile drift.

## Failed releases keep their version

While `agent-dealer@X.Y.Z` is not on npm and no GitHub Release exists for `vX.Y.Z`,
a failed release keeps its version: fix the problem, then delete and re-push the same
tag on the fixed commit (`git push origin :vX.Y.Z && git tag -f vX.Y.Z <fixed-sha> && git push origin vX.Y.Z`).
Do not bump to a new version to work around a failed publish.

## Trusted-publisher failures are owner-only

If the workflow's publish step fails with an OIDC `package not found` error
(`OIDC token exchange error - package not found`, then `ENEEDAUTH`), the cause is the
trusted-publisher setting on [npmjs.com](https://npmjs.com) (GitHub Actions, `not-so-fat` /
`agent-dealer`, workflow `release.yml`, environment `npm`) — not the repo. Only the owner
changes that setting; no repo change fixes it. Re-run the workflow after the owner fixes it.

## Dev monorepo

Repo root stays `"private": true`. Use `npm run dev` from a git checkout.

## Publish command (manual fallback only)

Normal releases publish from GitHub Actions (`release.yml`, trusted publishing — no login).
Local `publish:packages` stays as a documented manual fallback for when Actions cannot publish:

```bash
npm run publish:packages              # stages + cd into stage dir + npm publish
npm run publish:packages -- --otp=… # 2FA (fallback needs npm login + OTP)
```

**Never** `npm publish` from repo root — `EPRIVATE` (root is `private: true`, same package name).

Implementation: `scripts/stage-npm-package.mjs` → `.temporal/npm-stage/agent-dealer` → `scripts/publish-npm.sh`.
The staged `package.json` pins `repository.url` to `git+https://github.com/not-so-fat/agent-dealer.git` (provenance requirement).
