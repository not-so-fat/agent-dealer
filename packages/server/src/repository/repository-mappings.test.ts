// NOT-260: label → repository mapping persistence — JSON under
// `linear.repositoryMappings` in intake_settings, atomic replace, overwrite,
// duplicate rejection without touching the last valid array.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-repo-mappings-"));

const { migrate } = await import("../db/index.js");
const {
  listRepositoryMappings,
  replaceRepositoryMappings,
} = await import("./repository-mappings.js");

before(() => {
  migrate();
});

test("a fresh install returns an empty mapping array", () => {
  assert.deepEqual(listRepositoryMappings(), []);
});

test("saving normalizes label and repository", () => {
  const saved = replaceRepositoryMappings({
    mappings: [{ label: "  agent-dealer ", repository: "not-so-fat/agent-dealer" }],
  });
  assert.deepEqual(saved, [
    { label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" },
  ]);
  assert.deepEqual(listRepositoryMappings(), saved);
});

test("editing the repository for an existing unique label overwrites it", () => {
  replaceRepositoryMappings({
    mappings: [{ label: "agent-dealer", repository: "not-so-fat/agent-dealer" }],
  });
  const saved = replaceRepositoryMappings({
    mappings: [{ label: "agent-dealer", repository: "not-so-fat/other" }],
  });
  assert.deepEqual(saved, [
    { label: "agent-dealer", repository: "github.com/not-so-fat/other" },
  ]);
  const listed = listRepositoryMappings();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], {
    label: "agent-dealer",
    repository: "github.com/not-so-fat/other",
  });
});

test("duplicate normalized labels fail without changing the last valid array", () => {
  replaceRepositoryMappings({
    mappings: [{ label: "agent-dealer", repository: "not-so-fat/other" }],
  });
  assert.throws(
    () =>
      replaceRepositoryMappings({
        mappings: [
          { label: "agent-dealer", repository: "not-so-fat/agent-dealer" },
          { label: "  AGENT-dealer ", repository: "not-so-fat/other" },
        ],
      }),
    /Duplicate repository mapping/
  );
  assert.deepEqual(listRepositoryMappings(), [
    { label: "agent-dealer", repository: "github.com/not-so-fat/other" },
  ]);
});

test("empty labels, invalid repositories, and 101 rows fail atomically", () => {
  replaceRepositoryMappings({
    mappings: [{ label: "agent-dealer", repository: "not-so-fat/other" }],
  });
  const beforeRows = listRepositoryMappings();

  assert.throws(
    () => replaceRepositoryMappings({ mappings: [{ label: "   ", repository: "a/b" }] }),
    /must not be empty/
  );
  assert.deepEqual(listRepositoryMappings(), beforeRows);

  assert.throws(
    () => replaceRepositoryMappings({ mappings: [{ label: "ok", repository: "not a repo!!" }] }),
    /Invalid repository/
  );
  assert.deepEqual(listRepositoryMappings(), beforeRows);

  const many = Array.from({ length: 101 }, (_, i) => ({ label: `l${i}`, repository: "a/b" }));
  assert.throws(() => replaceRepositoryMappings({ mappings: many }), /At most 100/);
  assert.deepEqual(listRepositoryMappings(), beforeRows);
});

test("replacement is whole-array: omitted labels disappear, shared targets stay", () => {
  replaceRepositoryMappings({
    mappings: [
      { label: "agent-dealer", repository: "not-so-fat/agent-dealer" },
      { label: "dealer", repository: "not-so-fat/agent-dealer" },
    ],
  });
  const saved = replaceRepositoryMappings({
    mappings: [{ label: "dealer", repository: "not-so-fat/agent-dealer" }],
  });
  assert.deepEqual(saved, [{ label: "dealer", repository: "github.com/not-so-fat/agent-dealer" }]);
  assert.deepEqual(listRepositoryMappings(), saved);
});
