// NOT-314: `[operator]` criterion parser — pure cases (no DB).
// NOT-575: only the trailing tag decides (never a mention in the text).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  criteriaTextsFromActionEvidence,
  extractOperatorCriteria,
  extractOperatorCriteriaFromContract,
  hasTrailingOperatorTag,
  operatorCriteriaForSnapshot,
} from "./operator-criteria.js";

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

test("NOT-575: only the trailing tag decides — leading, middle, and bare mention do not gate", () => {
  const criteria = extractOperatorCriteria(
    [
      "- [ ] [operator] Leading tag proves login",
      "- [ ] Middle [operator] tag proves login",
      "- [ ] Trailing tag proves login [operator]",
      "- [ ] [operator]",
    ].join("\n")
  );
  // The bare `[operator]` line IS a trailing tag (the whole text is the tag);
  // leading and middle mentions never open the gate.
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0]!.text, "Trailing tag proves login [operator]");
  assert.equal(criteria[1]!.text, "[operator]");
});

test("NOT-575: a criterion ending in [agent] whose text mentions [operator] is not flagged", () => {
  // The NOT-568 shape: the [agent] criterion's prose merely contained the
  // string [operator], while the real [operator] criterion gated.
  const criteria = extractOperatorCriteria(
    [
      "- [ ] Verify the [operator] handoff renders for the agent review [agent]",
      "  Evidence: agent run | run the render test | green",
      "- [ ] Operator can sign in with SSO and see the org dashboard [operator]",
      "  Evidence: operator run | `npm run probe:sso -- --env staging` | dashboard lists orgs",
    ].join("\n")
  );
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0]!.text, "Operator can sign in with SSO and see the org dashboard [operator]");
  assert.deepEqual(criteria[0]!.commands, [
    "Evidence: operator run | `npm run probe:sso -- --env staging` | dashboard lists orgs",
  ]);
});

test("NOT-575: trailing-tag matching is case-insensitive and tolerates trailing whitespace", () => {
  const criteria = extractOperatorCriteria(
    ["- [ ] First [OPERATOR]  ", "- [ ] Second [Operator]\t", "- [ ] Third [oPeRaToR]"].join("\n")
  );
  assert.equal(criteria.length, 3);
});

test("NOT-575: hasTrailingOperatorTag — last tag wins, punctuation after the tag is not a tag", () => {
  assert.equal(hasTrailingOperatorTag("Proves login [operator]"), true);
  assert.equal(hasTrailingOperatorTag("Proves login [OPERATOR]"), true);
  assert.equal(hasTrailingOperatorTag("Proves login [operator]   "), true);
  assert.equal(hasTrailingOperatorTag("[operator]"), true);
  assert.equal(hasTrailingOperatorTag("Mentions [operator] then ends [agent]"), false);
  assert.equal(hasTrailingOperatorTag("[operator] Leading tag proves login"), false);
  assert.equal(hasTrailingOperatorTag("Proves login [operator]."), false);
  assert.equal(hasTrailingOperatorTag("Proves login [operators]"), false);
  assert.equal(hasTrailingOperatorTag("Two tags [agent] [operator]"), true);
  assert.equal(hasTrailingOperatorTag("Two tags [operator] [agent]"), false);
  assert.equal(hasTrailingOperatorTag("No tag at all"), false);
  assert.equal(hasTrailingOperatorTag(""), false);
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

test("NOT-575: the contract's indented Evidence: line is collected, not a block terminator", () => {
  const criteria = extractOperatorCriteria(
    [
      "- [ ] Paid checkout works end to end [operator]",
      "  Evidence: operator run | `npm run probe:checkout -- --env staging` | receipt shown",
      "  - see docs/probes/checkout.md for the test card",
    ].join("\n")
  );
  assert.equal(criteria.length, 1);
  assert.deepEqual(criteria[0]!.commands, [
    "Evidence: operator run | `npm run probe:checkout -- --env staging` | receipt shown",
    "see docs/probes/checkout.md for the test card",
  ]);
});

test("NOT-575: the nested-bullet Evidence form collects the same way", () => {
  const criteria = extractOperatorCriteria(
    ["- [ ] Paid checkout works end to end [operator]", "  * Evidence: operator run | paste the output | reviewed"].join(
      "\n"
    )
  );
  assert.equal(criteria.length, 1);
  assert.deepEqual(criteria[0]!.commands, ["Evidence: operator run | paste the output | reviewed"]);
});

test("NOT-575: contract criteria gate on the trailing tag with their evidence as the command", () => {
  const criteria = extractOperatorCriteriaFromContract({
    version: "v1",
    executionMode: "bug fix",
    nonGoals: ["x"],
    exitPredicate: "done",
    onePrStoppingPoint: "stop",
    acceptanceCriteria: [
      { text: "Verify the [operator] handoff renders [agent]", evidence: "agent run" },
      { text: "Operator signs in with SSO [operator]", evidence: "operator run | paste the output" },
      { text: "Untagged work", evidence: null },
    ],
  });
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0]!.text, "Operator signs in with SSO [operator]");
  assert.deepEqual(criteria[0]!.commands, ["Evidence: operator run | paste the output"]);
  assert.deepEqual(extractOperatorCriteriaFromContract(null), []);
  assert.deepEqual(extractOperatorCriteriaFromContract(undefined), []);
});

test("NOT-575: the snapshot union dedupes AC text and contract by exact criterion text", () => {
  const merged = operatorCriteriaForSnapshot({
    acceptanceCriteria: "- [ ] Operator signs in with SSO [operator]\n  Evidence: ac text evidence",
    executionContract: {
      version: "v1",
      executionMode: "bug fix",
      nonGoals: ["x"],
      exitPredicate: "done",
      onePrStoppingPoint: "stop",
      acceptanceCriteria: [
        { text: "Operator signs in with SSO [operator]", evidence: "contract evidence" },
        { text: "Operator completes a paid checkout [operator]", evidence: "checkout evidence" },
      ],
    },
  });
  // The shared criterion appears once (AC-text form wins); the contract-only
  // criterion still gates even though the AC string diverges from it.
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.text, "Operator signs in with SSO [operator]");
  assert.deepEqual(merged[0]!.commands, ["Evidence: ac text evidence"]);
  assert.equal(merged[1]!.text, "Operator completes a paid checkout [operator]");
  assert.deepEqual(merged[1]!.commands, ["Evidence: checkout evidence"]);
});

test("NOT-575 repair 2: a Linear-escaped trailing \\[operator\\] gates with its Evidence line", () => {
  // Linear markdown escapes the tag brackets; intake and the contract
  // compiler keep the raw `\[operator\]` text, so the gate must accept it —
  // the NOT-567/569-572 tickets merged with no operator action because it did not.
  const criteria = extractOperatorCriteria(
    [
      "- [ ] Agent can list sessions from the registry \\[agent\\]",
      "  Evidence: unit tests | run the registry suite | green",
      "- [ ] Operator can sign in with SSO and see the org dashboard \\[operator\\]",
      "  Evidence: operator run | `npm run probe:sso -- --env staging` | dashboard lists orgs",
    ].join("\n")
  );
  assert.equal(criteria.length, 1);
  assert.equal(
    criteria[0]!.text,
    "Operator can sign in with SSO and see the org dashboard \\[operator\\]"
  );
  assert.deepEqual(criteria[0]!.commands, [
    "Evidence: operator run | `npm run probe:sso -- --env staging` | dashboard lists orgs",
  ]);
});

test("NOT-575 repair 2: an escaped \\[agent\\] line mentioning [operator] is not flagged", () => {
  // The NOT-568 mis-flag shape under Linear escaping: the [agent]
  // criterion's prose contains the string [operator] (backticked, unescaped)
  // but its trailing tag is `\[agent\]` — never a gate. The genuine escaped
  // `\[operator\]` criterion alongside it still gates.
  const criteria = extractOperatorCriteria(
    [
      "- [ ] Verify the `[operator]` handoff renders for the agent review \\[agent\\]",
      "  Evidence: agent run | run the render test | green",
      "- [ ] Operator can sign in with SSO \\[operator\\]",
      "  Evidence: operator run | `npm run probe:sso` | dashboard shown",
    ].join("\n")
  );
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0]!.text, "Operator can sign in with SSO \\[operator\\]");
});

test("NOT-575 repair 2: hasTrailingOperatorTag accepts the escaped tag, still rejects escaped non-tags", () => {
  assert.equal(hasTrailingOperatorTag("Proves login \\[operator\\]"), true);
  assert.equal(hasTrailingOperatorTag("Proves login \\[OPERATOR\\]"), true);
  assert.equal(hasTrailingOperatorTag("Proves login \\[operator\\]   "), true);
  assert.equal(hasTrailingOperatorTag("\\[operator\\]"), true);
  assert.equal(hasTrailingOperatorTag("Mentions [operator] then ends \\[agent\\]"), false);
  assert.equal(hasTrailingOperatorTag("Proves login \\[agent\\]"), false);
  assert.equal(hasTrailingOperatorTag("Proves login \\[operators\\]"), false);
  assert.equal(hasTrailingOperatorTag("Proves login \\[operator\\]."), false);
  assert.equal(hasTrailingOperatorTag("Two tags \\[agent\\] \\[operator\\]"), true);
  assert.equal(hasTrailingOperatorTag("Two tags [operator] \\[agent\\]"), false);
});

test("NOT-575 repair 2: contract criteria gate on the escaped trailing tag", () => {
  const criteria = extractOperatorCriteriaFromContract({
    version: "v1",
    executionMode: "bug fix",
    nonGoals: ["x"],
    exitPredicate: "done",
    onePrStoppingPoint: "stop",
    acceptanceCriteria: [
      { text: "Verify the `[operator]` handoff renders \\[agent\\]", evidence: "agent run" },
      { text: "Operator signs in with SSO \\[operator\\]", evidence: "operator run | paste the output" },
    ],
  });
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0]!.text, "Operator signs in with SSO \\[operator\\]");
  assert.deepEqual(criteria[0]!.commands, ["Evidence: operator run | paste the output"]);
});

test("NOT-575: criteriaTextsFromActionEvidence reads the gated list, null when unreadable", () => {
  assert.deepEqual(
    criteriaTextsFromActionEvidence({
      evidenceJson: JSON.stringify({
        operatorVerification: {
          headSha: "abc",
          criteria: [
            { text: "First [operator]", commands: [] },
            { text: "Second [operator]", commands: ["Evidence: x"] },
          ],
        },
      }),
    }),
    ["First [operator]", "Second [operator]"]
  );
  assert.equal(criteriaTextsFromActionEvidence({ evidenceJson: null }), null);
  assert.equal(criteriaTextsFromActionEvidence({ evidenceJson: "not json" }), null);
  assert.equal(criteriaTextsFromActionEvidence({ evidenceJson: JSON.stringify({}) }), null);
  assert.equal(
    criteriaTextsFromActionEvidence({
      evidenceJson: JSON.stringify({ operatorVerification: { criteria: "nope" } }),
    }),
    null
  );
});
