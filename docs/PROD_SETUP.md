# Production setup

agent-dealer separates **development** (repo work) and **production** (local always-on instance) so ports, SQLite, and secrets do not collide.

## Host prerequisites (issue Dev→PR→Review)

Issue workflows always shell out to **GitHub CLI** (draft PR create, checks, auto-merge). Before kicking issues:

1. Install `gh` (`brew install gh` on macOS) and run `gh auth login -h github.com`
2. Prefer managed install at `~/.local/bin/agent-dealer` (`export PATH="$HOME/.local/bin:$PATH"`). Remove leftover `npm i -g agent-dealer` binaries under `/opt/homebrew/bin` (or similar) so an old global does not shadow 1.0.0+
3. Confirm with `agent-dealer doctor` — GitHub must be green before kicking issues (Start refuses when `gh` is missing or auth is invalid)

## Layout

| | Development | Production |
|---|-------------|------------|
| Mode | `AGENT_DEALER_ENV=development` | `AGENT_DEALER_ENV=production` |
| Env file | `~/.agent-dealer-dev/.env` | `~/.agent-dealer/.env` |
| Data dir | `~/.agent-dealer-dev/` | `~/.agent-dealer/` |
| API port | `3221` | `2221` |
| Web port | `3222` | `2222` |

`npm run dev` sets development mode. `npm run start` sets production mode.

## Bootstrap development

```bash
mkdir -p ~/.agent-dealer-dev
cp scripts/templates/dev.env.example ~/.agent-dealer-dev/.env
# Edit ~/.agent-dealer-dev/.env — add LINEAR_API_KEY, etc.
npm install
npm run build -w @agent-dealer/shared   # server resolves @agent-dealer/shared/dist
npm run db:migrate
npm run dev
```

Dashboard: **http://localhost:3222** · API: **http://127.0.0.1:3221**

## Bootstrap production

```bash
mkdir -p ~/.agent-dealer
cp scripts/templates/prod.env.example ~/.agent-dealer/.env
# Edit ~/.agent-dealer/.env — add LINEAR_API_KEY, etc.
npm install
npm run build                           # start runs dist/ — build before starting
npm run db:migrate:prod
npm run start
```

API listens on **http://127.0.0.1:2221** (`npm run start` from git). With **`npm install -g agent-dealer`**, `agent-dealer start --daemon` serves the bundled dashboard on **http://localhost:2222** (API + UI, one port).

**Daemon mode:** `agent-dealer start --daemon` spawns a detached supervisor; server logs go to `~/.agent-dealer/logs/` (`server.log`, `supervisor.log`). Foreground `agent-dealer start` still works for debugging in an open terminal. Stop with `agent-dealer stop`; check with `agent-dealer status`.

For git dev work, use `npm run dev` on **3222** (Vite) proxying API **3221**.

## Running dev and prod together

1. **Ports** — dev `3221/3222`, prod `2221/2222` (defaults).
2. **Database** — separate files under `~/.agent-dealer-dev` vs `~/.agent-dealer`.
3. **Linear** — use different API keys or disable write-back in dev (`linear.syncEnabled` in Inbox settings) to avoid duplicate comments.
4. **Startup log** — server prints mode, env file path, home dir, and port (no secrets).

## Migrating from pre-split installs

If you already have `~/.agent-dealer/dealer.db` from dogfooding:

- Treat it as **production** data; prod continues using `~/.agent-dealer`.
- Dev starts fresh at `~/.agent-dealer-dev` unless you copy the DB there intentionally.

If you have secrets in a repo-root `.env` from an older setup:

```bash
mkdir -p ~/.agent-dealer-dev
mv .env ~/.agent-dealer-dev/.env   # or copy and merge with dev.env.example
```

No automatic DB migration is provided in v0.

## Automate repository selection from Linear

Dealer's New issue form has one ordinary repository input. A Linear ticket
can pre-fill it automatically when the ticket carries a repository label —
one-time Linear setup, no Dealer-side mapping or sync action.

**1. Agree on the label convention.** The label name carries the canonical
repository identity directly:

```text
repo:github.com/<owner>/<repo>
```

`repo:github.com/not-so-fat/agent-dealer`, for example. One repository per
label, exactly one such label per issue. Dealer reads only labels whose name
starts with `repo:` (case-insensitive) and validates the remainder as a
GitHub repository; it never infers a repository from ticket text, team, or
product labels.

**2. Create the label once in Linear.** Settings → Labels → New label, named
e.g. `repo:github.com/not-so-fat/agent-dealer`. Repeat for each repository
you kick work for. This is an ordinary reusable workspace label — nothing
Dealer-specific about it.

**3. Attach it by default with an issue template (per repository).**
Linear issue templates can carry default labels: create one template per
repository (e.g. "Backend work" with `repo:github.com/<owner>/<repo>`
pre-applied) so every ticket filed from that template already declares where
it runs. Alternatively set a team-level default template whose labels the
author adjusts per issue.

**4. Optionally enforce it with a Triage Rule.** Linear's Triage automation
(Settings → Teams → Triage) can auto-apply a `repo:` label to incoming
issues — e.g. label everything entering a team's triage queue with that
team's repository, leaving exotic cases for the author to correct.

**What Dealer does with the label:** when you pick the ticket under New
issue → From Linear, Dealer fetches its labels, and exactly one valid
`repo:` label silently pre-fills the repository input — submission then
needs just the normal required fields (title, repository, developer,
reviewer). With no usable label the input is preserved as-is (type or pick
a recent repository directly); with conflicting or invalid labels Dealer
keeps your value and shows a compact inline warning. Dealer only
reads/validates the label — it needs no special Dealer operation and never
writes the label back.

## Overrides

Shell exports and values in the loaded `.env` override defaults. `AGENT_DEALER_HOME`, `PORT`, `WEB_PORT`, `AGENT_DEALER_API`, and `AGENT_DEALER_WEB_URL` can be set explicitly in either env file.
