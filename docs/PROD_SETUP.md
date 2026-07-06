# Production setup

agent-dealer separates **development** (repo work) and **production** (local always-on instance) so ports, SQLite, and secrets do not collide.

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
npm run db:migrate
npm run dev
```

Dashboard: **http://localhost:3222** · API: **http://127.0.0.1:3221**

## Bootstrap production

```bash
mkdir -p ~/.agent-dealer
cp scripts/templates/prod.env.example ~/.agent-dealer/.env
# Edit ~/.agent-dealer/.env — add LINEAR_API_KEY, etc.
npm run db:migrate:prod
npm run start
```

API listens on **http://127.0.0.1:2221** (`npm run start` from git). With **`npm install -g agent-dealer`**, `agent-dealer start` serves the bundled dashboard on **http://localhost:2222** (API + UI, one port).

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

## Overrides

Shell exports and values in the loaded `.env` override defaults. `AGENT_DEALER_HOME`, `PORT`, `WEB_PORT`, `AGENT_DEALER_API`, and `AGENT_DEALER_WEB_URL` can be set explicitly in either env file.
