import { cancelRun } from "../../api";

type Props = {
  busy: boolean;
  onRemoved: () => void | Promise<void>;
};

export default function RemoveFromOpsAction({ busy, onRemoved }: Props) {
  const confirmRemove = () => {
    if (
      !confirm(
        "Remove this task from Operations? It won't be marked done and can't be brought back here."
      )
    ) {
      return;
    }
    void onRemoved();
  };

  return (
    <div className="pt-2 border-t border-white/10">
      <button
        type="button"
        disabled={busy}
        onClick={confirmRemove}
        className="btn-ghost-danger w-full py-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Remove from Operations
      </button>
      <p className="text-xs text-white/35 text-center mt-1.5">
        Dismisses the task — not archived to Done.
      </p>
    </div>
  );
}
