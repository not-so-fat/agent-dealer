#!/usr/bin/env node
/**
 * Patch dev-deck pb_user_path_integration_smoke with generic npm monorepo lessons.
 * Usage: node scripts/patch-integration-smoke-playbook.mjs
 */
const DECK_ID = "6e825b59-13de-4ddd-ab7e-55ab5a1c279a";
const API = process.env.AGENT_DECK_API_URL ?? "http://127.0.0.1:1111";
const PLAYBOOK_ID = "pb_user_path_integration_smoke";

const INSERT_CHECKLIST_ROWS = `| 8 | Does **\`doctor\`/preflight** check real prerequisites? | Only Node version; missing external CLI the app spawns |
| 9 | Are **documented npm scripts** tracked in git? | README points at gitignored paths → clone “module not found” |
`;

const INSERT_MONOREPO = `
## Monorepo npm publish (unscoped or scoped)

When the **git monorepo root** is \`"private": true\` but you also publish an installable package:

| Pitfall | Fix |
|---------|-----|
| \`npm publish\` / \`--prefix\` from **repo root** | Publishes root \`package.json\` → **\`EPRIVATE\`** or wrong tarball |
| Same **name** on root and publishable package | npm resolves root workspace, not staged CLI |
| \`npm pack\` **excludes** \`node_modules\` | Stage \`bundle/\` + \`postinstall\`, or ship one fat artifact |
| **Empty** README-only publish | Useless \`npm install\`; ship CLI + bundled server/assets |
| Scoped \`@org/pkg\` without npm org | Stage **one unscoped** tarball or create org first |

**Pattern:** \`stage → cd staged-dir → npm publish\` (dedicated \`publish-*.sh\`). Gate with **\`install:smoke\`**: pack staged tarball → clean \`HOME\` → install → run documented command → curl health + UI.

Repo-specific publish rules belong in **that repo's** \`.cursor/rules/\` — not this generic playbook.
`;

const INSERT_FAILURE_ROW = `| **Prerequisite CLIs on PATH** | | ✗ |
`;

const INSERT_ANTIPATTERNS = `7. **\`npm publish\` from private monorepo root** (EPRIVATE / wrong package)
8. **Empty npm tarball** to “reserve a name” then bump each release
9. **README scripts** pointing at gitignored dirs
`;

const INSERT_AUTOMATE = `5. Hit **health + primary API** (and HTML shell if UI bundled)
`;

function patchBody(body) {
  let next = body;
  if (!next.includes("Prerequisite CLIs on PATH")) {
    next = next.replace(
      "| Published artifact = git tag | | ✗ |",
      "| Published artifact = git tag | | ✗ |\n" + INSERT_FAILURE_ROW,
    );
  }
  if (!next.includes("`doctor`/preflight")) {
    next = next.replace(
      "| 7 | Does the **published package** include the module? | Source in repo but not in tarball |",
      "| 7 | Does the **published package** include the module? | Source in repo but not in tarball |\n" + INSERT_CHECKLIST_ROWS,
    );
  }
  if (!next.includes("## Monorepo npm publish")) {
    next = next.replace("## Agent session before human handoff", INSERT_MONOREPO + "\n## Agent session before human handoff");
  }
  if (!next.includes("health + primary API")) {
    next = next.replace(
      "4. Assert artifacts + stdout contract\n\n**Publish fails**",
      "4. Assert artifacts + stdout contract\n" + INSERT_AUTOMATE + "\n**Publish fails**",
    );
  }
  if (!next.includes("Empty npm tarball")) {
    next = next.replace(
      "6. Assume **dev data** is visible to **prod** runtime\n\n## When done",
      "6. Assume **dev data** is visible to **prod** runtime\n" + INSERT_ANTIPATTERNS + "\n## When done",
    );
  }
  return next;
}

async function main() {
  const getRes = await fetch(`${API}/api/playbooks/${encodeURIComponent(PLAYBOOK_ID)}`, {
    headers: {
      "x-agent-deck-client": "agent",
      "x-agent-deck-deck-id": DECK_ID,
    },
  });
  if (!getRes.ok) throw new Error(`GET ${getRes.status}: ${await getRes.text()}`);
  const current = (await getRes.json()).data;
  const body = patchBody(current.body);
  if (body === current.body) {
    console.log("No change — playbook already patched");
    return;
  }
  const putRes = await fetch(`${API}/api/playbooks/${encodeURIComponent(PLAYBOOK_ID)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-agent-deck-client": "agent",
      "x-agent-deck-deck-id": DECK_ID,
    },
    body: JSON.stringify({ body, autoDetectDependencies: false }),
  });
  if (!putRes.ok) throw new Error(`PUT ${putRes.status}: ${await putRes.text()}`);
  console.log(`Updated ${PLAYBOOK_ID} on dev deck`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
