import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileExecutionContract,
  ExecutionContractError,
  hasExecutionContractSignal,
  renderContractAcceptanceCriteria,
  resolveIssueContractFields,
} from "./execution-contract.js";

/** Planner-authored Linear ticket carrying every contract-v1 heading. */
export const FULL_CONTRACT_DESCRIPTION = `Ship the frozen execution contract for Planner tickets.

## Builder execution mode
feature

## Non-goals
- Selecting a playbook or reasoning about implementation architecture
- Adding a generic workflow/schema editor

## Exit predicate
Importing a Planner-authored Linear ticket yields a versioned frozen execution contract visible in Dealer and both worker prompts.

## One-PR stopping point
Stop after the contract compiles from ticket Markdown, persists/freezes with the Issue workflow, appears read-only in Issue Detail, and renders in developer/reviewer prompts.

## Acceptance criteria
- [ ] Full ticket imports into the exact structured schema
  Evidence: shared compiler fixtures | run the compiler test | every field asserted
- [ ] Legacy issues without headings still start
  Evidence: migration tests | run the legacy suite | green
`;

test("a full contract description compiles into the exact structured schema", () => {
  const { contract, acceptanceCriteria, hasContractHeadings } =
    compileExecutionContract(FULL_CONTRACT_DESCRIPTION);
  assert.equal(hasContractHeadings, true);
  assert.deepStrictEqual(contract, {
    version: "v1",
    executionMode: "feature",
    nonGoals: [
      "Selecting a playbook or reasoning about implementation architecture",
      "Adding a generic workflow/schema editor",
    ],
    exitPredicate:
      "Importing a Planner-authored Linear ticket yields a versioned frozen execution contract visible in Dealer and both worker prompts.",
    onePrStoppingPoint:
      "Stop after the contract compiles from ticket Markdown, persists/freezes with the Issue workflow, appears read-only in Issue Detail, and renders in developer/reviewer prompts.",
    acceptanceCriteria: [
      {
        text: "Full ticket imports into the exact structured schema",
        evidence: "shared compiler fixtures | run the compiler test | every field asserted",
      },
      {
        text: "Legacy issues without headings still start",
        evidence: "migration tests | run the legacy suite | green",
      },
    ],
  });
  assert.equal(
    acceptanceCriteria,
    [
      "- [ ] Full ticket imports into the exact structured schema",
      "  Evidence: shared compiler fixtures | run the compiler test | every field asserted",
      "- [ ] Legacy issues without headings still start",
      "  Evidence: migration tests | run the legacy suite | green",
    ].join("\n")
  );
});

/**
 * Verbatim copy of the NOT-306 ticket's contract sections: `Feature.` mode
 * (trailing full stop, as Planner writes it) and nested `* Evidence:` bullets
 * (the Planner/Linear list format). The full task message repeats some
 * headings in its trailing checklist, so verbatim here means the ticket's
 * contract sections exactly as authored — one of each canonical heading.
 */
const NOT306_VERBATIM_DESCRIPTION = `Compile a Planner-authored Linear ticket into a frozen, machine-readable Agent Dealer execution contract without asking the operator to fill another technical form.

## Builder execution mode
Feature.

## Non-goals
* Making Dealer select a playbook or reason about implementation architecture.
* Adding a generic workflow/schema editor.
* Requiring the structured contract for every historical/manual issue.
* Rewriting the Linear ticket from Dealer.
* Automatically executing evidence commands in the coordinator.
* Changing product scope after a workflow starts.

## Exit predicate
Importing a Planner-authored Linear ticket yields a versioned frozen execution contract visible in Dealer and both worker prompts, while legacy tickets still work and the operator is never asked to duplicate the brief manually.

## One-PR stopping point
Execution-contract v1 compiles from ticket Markdown, persists/freezes with the Issue workflow, appears read-only in Issue Detail, and renders in developer/reviewer prompts. Stop before generic workflow templates or automatic evidence execution.

## Acceptance criteria
- [ ] A Linear description containing all contract-v1 headings imports into the exact structured schema while preserving the original Markdown unchanged.
  * Evidence: shared compiler fixtures assert every field and the untouched source.
- [ ] Web, API, and CLI creation paths use the same compiler; the page-local acceptance-criteria regex is removed.
  * Evidence: contract tests cover equivalent requests through each intake path.
- [ ] Issues with no contract-v1 headings retain current behavior and remain startable under existing readiness rules.
  * Evidence: legacy issue and migration tests pass unchanged.
- [ ] Once any contract heading is present, duplicate headings, unknown execution modes, empty exit predicates, duplicate AC text, and malformed Evidence lines return an actionable validation error.
  * Evidence: table-driven parser tests cover each invalid case.
- [ ] Starting a workflow freezes the compiled contract; later source edits do not alter an active workflow, while an allowed parked re-freeze updates source and compiled contract atomically.
  * Evidence: coordinator snapshot and NOT-185 regression tests.
- [ ] Developer and reviewer prompts render execution mode, non-goals, exit predicate, one-PR boundary, and per-criterion evidence without instructing the worker to rediscover them.
  * Evidence: exact prompt tests for both roles.
- [ ] Issue Detail shows the compiled contract read-only and does not introduce a second technical form.
  * Evidence: focused component test and rendered UI smoke.
- [ ] \`npm test\`, type-check, and package build pass.
`;

test("NOT-306 ticket verbatim (`Feature.` mode, nested `* Evidence:` bullets) imports", () => {
  const source = NOT306_VERBATIM_DESCRIPTION;
  const { contract, hasContractHeadings } = compileExecutionContract(source);
  assert.equal(hasContractHeadings, true);
  assert.equal(source, NOT306_VERBATIM_DESCRIPTION);
  assert.deepStrictEqual(contract, {
    version: "v1",
    executionMode: "feature",
    nonGoals: [
      "Making Dealer select a playbook or reason about implementation architecture.",
      "Adding a generic workflow/schema editor.",
      "Requiring the structured contract for every historical/manual issue.",
      "Rewriting the Linear ticket from Dealer.",
      "Automatically executing evidence commands in the coordinator.",
      "Changing product scope after a workflow starts.",
    ],
    exitPredicate:
      "Importing a Planner-authored Linear ticket yields a versioned frozen execution contract visible in Dealer and both worker prompts, while legacy tickets still work and the operator is never asked to duplicate the brief manually.",
    onePrStoppingPoint:
      "Execution-contract v1 compiles from ticket Markdown, persists/freezes with the Issue workflow, appears read-only in Issue Detail, and renders in developer/reviewer prompts. Stop before generic workflow templates or automatic evidence execution.",
    acceptanceCriteria: [
      {
        text: "A Linear description containing all contract-v1 headings imports into the exact structured schema while preserving the original Markdown unchanged.",
        evidence: "shared compiler fixtures assert every field and the untouched source.",
      },
      {
        text: "Web, API, and CLI creation paths use the same compiler; the page-local acceptance-criteria regex is removed.",
        evidence: "contract tests cover equivalent requests through each intake path.",
      },
      {
        text: "Issues with no contract-v1 headings retain current behavior and remain startable under existing readiness rules.",
        evidence: "legacy issue and migration tests pass unchanged.",
      },
      {
        text: "Once any contract heading is present, duplicate headings, unknown execution modes, empty exit predicates, duplicate AC text, and malformed Evidence lines return an actionable validation error.",
        evidence: "table-driven parser tests cover each invalid case.",
      },
      {
        text: "Starting a workflow freezes the compiled contract; later source edits do not alter an active workflow, while an allowed parked re-freeze updates source and compiled contract atomically.",
        evidence: "coordinator snapshot and NOT-185 regression tests.",
      },
      {
        text: "Developer and reviewer prompts render execution mode, non-goals, exit predicate, one-PR boundary, and per-criterion evidence without instructing the worker to rediscover them.",
        evidence: "exact prompt tests for both roles.",
      },
      {
        text: "Issue Detail shows the compiled contract read-only and does not introduce a second technical form.",
        evidence: "focused component test and rendered UI smoke.",
      },
      {
        text: "`npm test`, type-check, and package build pass.",
        evidence: null,
      },
    ],
  });
});

test("a criterion without an Evidence line keeps a null evidence", () => {
  const { contract } = compileExecutionContract(
    [
      "## Builder execution mode",
      "refactor",
      "",
      "## Non-goals",
      "- nothing",
      "",
      "## Exit predicate",
      "The refactor lands with no behavior change.",
      "",
      "## One-PR stopping point",
      "Stop at the refactor.",
      "",
      "## Acceptance criteria",
      "- [ ] Behavior is unchanged",
      "- [x] Types still check",
      "",
    ].join("\n")
  );
  assert.deepStrictEqual(contract?.acceptanceCriteria, [
    { text: "Behavior is unchanged", evidence: null },
    { text: "Types still check", evidence: null },
  ]);
});

test("compilation preserves the original Markdown — the contract is derived data", () => {
  const source = FULL_CONTRACT_DESCRIPTION;
  compileExecutionContract(source);
  assert.equal(source, FULL_CONTRACT_DESCRIPTION);
  const { acceptanceCriteria } = compileExecutionContract(source);
  assert.ok(acceptanceCriteria);
  // The derived text is a rendering of the criteria, not a rewrite of the ticket.
  assert.ok(!acceptanceCriteria.includes("## Non-goals"));
});

test("a description with no contract headings stays a compatible legacy issue", () => {
  for (const description of [null, undefined, "", "  ", "Just a plain description.", "# Title\n\nSome *other* sections."]) {
    const compiled = compileExecutionContract(description);
    assert.equal(compiled.contract, null);
    assert.equal(compiled.acceptanceCriteria, null);
    assert.equal(compiled.hasContractHeadings, false);
  }
  assert.equal(hasExecutionContractSignal("plain text"), false);
  assert.equal(hasExecutionContractSignal(null), false);
});

test("an Acceptance-criteria-only ticket keeps the legacy raw-text extraction", () => {
  const compiled = compileExecutionContract(
    ["Ship it.", "", "## Acceptance criteria", "It works and it ships.", ""].join("\n")
  );
  assert.equal(compiled.contract, null);
  assert.equal(compiled.hasContractHeadings, true);
  assert.equal(compiled.acceptanceCriteria, "It works and it ships.");
  assert.equal(hasExecutionContractSignal("## Acceptance criteria\nIt works."), false);
});

test("each signal heading marks a contract ticket", () => {
  assert.equal(hasExecutionContractSignal("## Builder execution mode\nfeature"), true);
  assert.equal(hasExecutionContractSignal("## Non-goals\n- x"), true);
  assert.equal(hasExecutionContractSignal("## Exit predicate\ndone when done"), true);
  assert.equal(hasExecutionContractSignal("## One-PR stopping point\nstop here"), true);
});

test("execution mode accepts case/whitespace/punctuation variants of the enum", () => {
  const build = (mode: string) =>
    [
      "## Builder execution mode",
      mode,
      "",
      "## Non-goals",
      "- x",
      "",
      "## Exit predicate",
      "Done.",
      "",
      "## One-PR stopping point",
      "Stop.",
      "",
      "## Acceptance criteria",
      "- [ ] Done",
      "",
    ].join("\n");
  assert.equal(compileExecutionContract(build("Feature")).contract?.executionMode, "feature");
  assert.equal(compileExecutionContract(build("Feature.")).contract?.executionMode, "feature");
  assert.equal(compileExecutionContract(build("  BUG-FIX  ")).contract?.executionMode, "bug fix");
  assert.equal(compileExecutionContract(build("bugfix")).contract?.executionMode, "bug fix");
  assert.equal(compileExecutionContract(build("Refactor")).contract?.executionMode, "refactor");
  assert.equal(compileExecutionContract(build("INVESTIGATION")).contract?.executionMode, "investigation");
  assert.equal(compileExecutionContract(build("split child")).contract?.executionMode, "split child");
  assert.equal(compileExecutionContract(build("Split-Child")).contract?.executionMode, "split child");
});

test("heading names match case-insensitively and across hyphen variants", () => {
  const { contract } = compileExecutionContract(
    [
      "## BUILDER EXECUTION MODE",
      "feature",
      "",
      "## Non goals",
      "- x",
      "",
      "## exit predicate",
      "Done.",
      "",
      "## One PR stopping point",
      "Stop.",
      "",
      "## ACCEPTANCE CRITERIA",
      "- [ ] Done",
      "",
    ].join("\n")
  );
  assert.equal(contract?.executionMode, "feature");
  assert.deepStrictEqual(contract?.nonGoals, ["x"]);
});

/** Every invalid shape returns an actionable error instead of dropping fields. */
const INVALID_CASES: Array<{ name: string; description: string; match: RegExp }> = [
  {
    name: "duplicate headings",
    description: [
      "## Builder execution mode",
      "feature",
      "",
      "## Builder execution mode",
      "refactor",
      "",
      "## Non-goals",
      "- x",
      "",
      "## Exit predicate",
      "Done.",
      "",
      "## One-PR stopping point",
      "Stop.",
      "",
      "## Acceptance criteria",
      "- [ ] Done",
      "",
    ].join("\n"),
    match: /duplicate.*Builder execution mode/i,
  },
  {
    name: "duplicate acceptance-criteria heading",
    description: ["## Acceptance criteria", "A.", "", "## Acceptance criteria", "B.", ""].join("\n"),
    match: /duplicate.*Acceptance criteria/i,
  },
  {
    name: "unknown execution mode",
    description: [
      "## Builder execution mode",
      "teleport",
      "",
      "## Non-goals",
      "- x",
      "",
      "## Exit predicate",
      "Done.",
      "",
      "## One-PR stopping point",
      "Stop.",
      "",
      "## Acceptance criteria",
      "- [ ] Done",
      "",
    ].join("\n"),
    match: /unknown execution mode.*feature \| bug fix \| refactor \| investigation \| split child/i,
  },
  {
    name: "missing execution mode section",
    description: [
      "## Non-goals",
      "- x",
      "",
      "## Exit predicate",
      "Done.",
      "",
      "## One-PR stopping point",
      "Stop.",
      "",
      "## Acceptance criteria",
      "- [ ] Done",
      "",
    ].join("\n"),
    match: /missing.*Builder execution mode/i,
  },
  {
    name: "empty exit predicate",
    description: [
      "## Builder execution mode",
      "feature",
      "",
      "## Non-goals",
      "- x",
      "",
      "## Exit predicate",
      "",
      "## One-PR stopping point",
      "Stop.",
      "",
      "## Acceptance criteria",
      "- [ ] Done",
      "",
    ].join("\n"),
    match: /Exit predicate.*observable completion statement/i,
  },
  {
    name: "empty one-PR stopping point",
    description: [
      "## Builder execution mode",
      "feature",
      "",
      "## Non-goals",
      "- x",
      "",
      "## Exit predicate",
      "Done.",
      "",
      "## One-PR stopping point",
      "   ",
      "",
      "## Acceptance criteria",
      "- [ ] Done",
      "",
    ].join("\n"),
    match: /One-PR stopping point.*boundary/i,
  },
  {
    name: "empty non-goals",
    description: [
      "## Builder execution mode",
      "feature",
      "",
      "## Non-goals",
      "",
      "## Exit predicate",
      "Done.",
      "",
      "## One-PR stopping point",
      "Stop.",
      "",
      "## Acceptance criteria",
      "- [ ] Done",
      "",
    ].join("\n"),
    match: /Non-goals.*at least one/i,
  },
  {
    name: "duplicate acceptance-criterion text",
    description: [
      "## Builder execution mode",
      "feature",
      "",
      "## Non-goals",
      "- x",
      "",
      "## Exit predicate",
      "Done.",
      "",
      "## One-PR stopping point",
      "Stop.",
      "",
      "## Acceptance criteria",
      "- [ ] Ship it",
      "- [ ] SHIP  IT",
      "",
    ].join("\n"),
    match: /duplicate criterion/i,
  },
  {
    name: "empty Evidence line",
    description: [
      "## Builder execution mode",
      "feature",
      "",
      "## Non-goals",
      "- x",
      "",
      "## Exit predicate",
      "Done.",
      "",
      "## One-PR stopping point",
      "Stop.",
      "",
      "## Acceptance criteria",
      "- [ ] Ship it",
      "  Evidence:",
      "",
    ].join("\n"),
    match: /empty.*Evidence/i,
  },
  {
    name: "orphan Evidence line",
    description: [
      "## Builder execution mode",
      "feature",
      "",
      "## Non-goals",
      "- x",
      "",
      "## Exit predicate",
      "Done.",
      "",
      "## One-PR stopping point",
      "Stop.",
      "",
      "## Acceptance criteria",
      "  Evidence: somewhere | do thing | see result",
      "- [ ] Ship it",
      "",
    ].join("\n"),
    match: /Evidence.*before any criterion/i,
  },
  {
    name: "free-text acceptance-criteria line",
    description: [
      "## Builder execution mode",
      "feature",
      "",
      "## Non-goals",
      "- x",
      "",
      "## Exit predicate",
      "Done.",
      "",
      "## One-PR stopping point",
      "Stop.",
      "",
      "## Acceptance criteria",
      "Just ship it, somehow.",
      "",
    ].join("\n"),
    match: /checkbox items.*Evidence/i,
  },
];

for (const { name, description, match } of INVALID_CASES) {
  test(`invalid contract is rejected with an actionable error: ${name}`, () => {
    assert.throws(() => compileExecutionContract(description), (err) => {
      assert.ok(err instanceof ExecutionContractError, `expected ExecutionContractError, got ${err}`);
      assert.match((err as Error).message, match);
      return true;
    });
  });
}

test("resolveIssueContractFields never silently drops an explicit value", () => {
  const explicit = "Operator-typed criteria";
  const resolved = resolveIssueContractFields(FULL_CONTRACT_DESCRIPTION, explicit);
  assert.ok(resolved.executionContract);
  assert.equal(resolved.acceptanceCriteria, explicit);
  const derived = resolveIssueContractFields(FULL_CONTRACT_DESCRIPTION, undefined);
  assert.ok(derived.executionContract);
  assert.equal(derived.acceptanceCriteria, renderContractAcceptanceCriteria(derived.executionContract!));
  const legacy = resolveIssueContractFields("plain", "  kept  ");
  assert.equal(legacy.executionContract, null);
  assert.equal(legacy.acceptanceCriteria, "  kept  ");
  const legacyDerived = resolveIssueContractFields("## Acceptance criteria\nRaw text.", "");
  assert.equal(legacyDerived.executionContract, null);
  assert.equal(legacyDerived.acceptanceCriteria, "Raw text.");
});
