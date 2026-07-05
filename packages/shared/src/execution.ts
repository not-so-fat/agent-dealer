export type ExecutionBlocker = {
  detected: boolean;
  summary?: string;
};

/** Detect agent-reported blockers in result text (permission, approval, etc.). */
export function detectExecutionBlocker(resultText: string | undefined | null): ExecutionBlocker {
  if (!resultText?.trim()) return { detected: false };

  const bold = resultText.match(/\*\*Blocker:\*\*\s*([^\n]+)/i);
  if (bold) return { detected: true, summary: bold[1]!.trim() };

  const plain = resultText.match(/^Blocker:\s*([^\n]+)/im);
  if (plain) return { detected: true, summary: plain[1]!.trim() };

  const signals = [
    /can't complete the deliverable/i,
    /cannot complete the deliverable/i,
    /needs explicit approval/i,
    /permission grant i can't obtain/i,
    /no prompt available in this session/i,
    /were both blocked/i,
    /without that permission being pre-approved/i,
    /can't obtain \(no prompt available/i,
  ];
  if (signals.some((re) => re.test(resultText))) {
    const line = resultText.trim().split(/\n/)[0] ?? "Execution blocked";
    return { detected: true, summary: line.slice(0, 220) };
  }

  return { detected: false };
}

export function resolveExecutionBlocker(input: {
  exitCode: number;
  resultText?: string;
  isError?: boolean;
  blocker?: { summary?: string };
}): ExecutionBlocker {
  if (input.blocker?.summary) {
    return { detected: true, summary: input.blocker.summary };
  }
  const fromText = detectExecutionBlocker(input.resultText);
  if (fromText.detected) return fromText;
  if (input.isError || input.exitCode !== 0) {
    const summary =
      input.resultText?.trim().split(/\n/)[0]?.slice(0, 220) ||
      (input.exitCode !== 0 ? `Process exited with code ${input.exitCode}` : "Agent reported an error");
    return { detected: true, summary };
  }
  return { detected: false };
}
