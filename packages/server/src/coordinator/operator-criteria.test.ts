// NOT-314: `[operator]` criterion parser — pure cases (no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOperatorCriteria } from "./operator-criteria.js";

test("two [operator] ACs return both; the indented command sub-bullet is collected", () => {
  const criteria = extractOperatorCriteria(
    [
      "- [ ] Agent can list sessions from the registry",
      "- [ ] Operator can sign in with SSO and see the org dashboard [operator]",
      "  - `npm run probe:sso -- --env staging`",
      "- [ ] Sessions expire after 30 days of inactivity",
      "- [ ] Operator can complete a paid checkout in the sandbox [operator]",
      "",
      "- [ ] Docs describe the probe",
    ].join("\n")
  );
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0]!.text, "Operator can sign in with SSO and see the org dashboard [operator]");
  assert.deepEqual(criteria[0]!.commands, ["`npm run probe:sso -- --env staging`"]);
  assert.equal(criteria[1]!.text, "Operator can complete a paid checkout in the sandbox [operator]");
  assert.deepEqual(criteria[1]!.commands, []);
});

test("a snapshot with no [operator] AC returns an empty list", () => {
  assert.deepEqual(
    extractOperatorCriteria("- [ ] Agent lists sessions\n- [ ] Sessions expire after 30d\n"),
    []
  );
  assert.deepEqual(extractOperatorCriteria(""), []);
});

test("tag case variants match: [OPERATOR], [Operator], [oPeRaToR]", () => {
  const criteria = extractOperatorCriteria(
    ["- [ ] First [OPERATOR]", "- [ ] Second [Operator]", "- [ ] Third [oPeRaToR]"].join("\n")
  );
  assert.equal(criteria.length, 3);
});

test("tag position variants match: leading, middle, trailing, and bare", () => {
  const criteria = extractOperatorCriteria(
    [
      "- [ ] [operator] Leading tag proves login",
      "- [ ] Middle [operator] tag proves login",
      "- [ ] Trailing tag proves login [operator]",
      "- [ ] [operator]",
    ].join("\n")
  );
  assert.equal(criteria.length, 4);
  assert.equal(criteria[0]!.text, "[operator] Leading tag proves login");
});

test("multiple indented sub-bullets all collect; blank lines inside the block are skipped", () => {
  const criteria = extractOperatorCriteria(
    [
      "- [ ] Paid checkout works end to end [operator]",
      "  - `npm run probe:checkout -- --env staging`",
      "",
      "  - see docs/probes/checkout.md for the test card",
    ].join("\n")
  );
  assert.equal(criteria.length, 1);
  assert.deepEqual(criteria[0]!.commands, [
    "`npm run probe:checkout -- --env staging`",
    "see docs/probes/checkout.md for the test card",
  ]);
});

test("indented (nested) checkboxes never open the gate, even with the tag", () => {
  const criteria = extractOperatorCriteria(
    ["- [ ] Parent task", "  - [ ] Nested subtask [operator]", "- [ ] Other"].join("\n")
  );
  assert.deepEqual(criteria, []);
});

test("a checked box with the tag still matches, and `*` markers work", () => {
  const criteria = extractOperatorCriteria(
    ["* [x] Already proven by hand [operator]", "- [ ] Plain task"].join("\n")
  );
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0]!.text, "Already proven by hand [operator]");
});

test("the next top-level checkbox ends the command block; prose ends it too", () => {
  const criteria = extractOperatorCriteria(
    [
      "- [ ] First [operator]",
      "  - `cmd-one`",
      "- [ ] Second without tag",
      "- [ ] Third [operator]",
      "  - `cmd-three`",
      "Trailing prose, not a bullet.",
      "- [ ] Fourth [operator]",
    ].join("\n")
  );
  assert.equal(criteria.length, 3);
  assert.deepEqual(criteria[0]!.commands, ["`cmd-one`"]);
  assert.deepEqual(criteria[1]!.commands, ["`cmd-three`"]);
  assert.deepEqual(criteria[2]!.commands, []);
});

test("[agent] in AC text is not an operator criterion", () => {
  assert.deepEqual(extractOperatorCriteria("- [ ] Agent lists sessions [agent]\n"), []);
});
