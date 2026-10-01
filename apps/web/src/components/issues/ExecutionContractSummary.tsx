import type { ExecutionContractV1 } from "@agent-dealer/shared";

/**
 * NOT-306: compact read-only execution-contract summary for Issue Detail.
 * The contract is compiled from the ticket description (the only authoring
 * surface) — this component renders it and offers no inputs, so the operator
 * is never asked to duplicate the brief through a second technical form.
 */
export default function ExecutionContractSummary({ contract }: { contract: ExecutionContractV1 }) {
  return (
    <section aria-label="Execution contract" className="mb-4 p-3 rounded border border-white/10 bg-white/[0.03] space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-xs text-white/45 uppercase tracking-wide">Execution contract</p>
        <span className="text-[11px] px-1.5 py-0.5 rounded border border-cyber-teal/40 text-cyber-teal">
          {contract.version}
        </span>
        <span className="text-[11px] px-1.5 py-0.5 rounded border border-white/15 text-white/70">
          {contract.executionMode}
        </span>
      </div>
      <div className="text-sm text-white/85 space-y-1.5">
        <p>
          <span className="text-white/45">Exit predicate: </span>
          {contract.exitPredicate}
        </p>
        <p>
          <span className="text-white/45">One-PR stopping point: </span>
          {contract.onePrStoppingPoint}
        </p>
        <div>
          <p className="text-white/45">Non-goals:</p>
          <ul className="list-disc pl-5 text-white/75">
            {contract.nonGoals.map((goal) => (
              <li key={goal}>{goal}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-white/45">Acceptance criteria:</p>
          <ul className="space-y-1">
            {contract.acceptanceCriteria.map((criterion) => (
              <li key={criterion.text}>
                <p className="text-white/80">☐ {criterion.text}</p>
                {criterion.evidence && (
                  <p className="pl-5 text-xs text-white/55">Evidence: {criterion.evidence}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="text-[11px] text-white/35">Compiled from the ticket description — edit the description to change it.</p>
    </section>
  );
}
