import { Link } from "react-router-dom";

/** Unknown application path — do not silently treat typos as the Issues home. */
export default function NotFoundPage() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-10">
      <div className="max-w-md space-y-3">
        <h2 className="text-lg font-semibold text-white/90">Page not found</h2>
        <p className="text-sm text-white/55">
          That URL is not a destination in Agent Dealer.
        </p>
        <Link to="/issues" className="inline-block text-sm text-cyber-teal hover:underline">
          ← Back to Issues
        </Link>
      </div>
    </div>
  );
}
