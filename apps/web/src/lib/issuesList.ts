// NOT-228: pure view-model for the Issues list filter bar + pagination (no
// React/DOM — tested with node:test via tsx, see issuesList.test.ts). Draft
// form edits live in component state; only applied URL state drives fetching,
// so reload and back/forward restore the same view and Previous/Next never
// smuggle in unapplied drafts.

export const ISSUE_STATUS_OPTIONS = [
  "ready",
  "developing",
  "reviewing",
  "repairing",
  "final_review",
  "needs_human",
  "done",
  "closed",
] as const;

export interface IssuesFilterForm {
  q: string;
  status: string;
  repo: string;
  needsAttention: boolean;
}

export const EMPTY_ISSUES_FORM: IssuesFilterForm = {
  q: "",
  status: "",
  repo: "",
  needsAttention: false,
};

export interface IssuesAppliedFilters {
  q?: string;
  status?: string;
  repo?: string;
  needsAttention?: boolean;
  page?: number;
}

function strip(search: string): string {
  return search.startsWith("?") ? search.slice(1) : search;
}

/** Draft form state from the raw URL search. Page lives in the URL only. */
export function searchToIssuesForm(search: string): IssuesFilterForm {
  const qs = new URLSearchParams(strip(search));
  return {
    q: qs.get("q")?.trim() ?? "",
    status: qs.get("status")?.trim() ?? "",
    repo: qs.get("repo")?.trim() ?? "",
    needsAttention: qs.get("needsAttention") === "1" || qs.get("needsAttention") === "true",
  };
}

/** Fetch filters from the raw URL search only — exactly what the URL says. */
export function searchToIssuesFilters(search: string): IssuesAppliedFilters {
  const qs = new URLSearchParams(strip(search));
  const pick = (k: string): string | undefined => {
    const v = qs.get(k)?.trim();
    return v ? v : undefined;
  };
  const out: IssuesAppliedFilters = {};
  const q = pick("q");
  if (q !== undefined) out.q = q;
  const status = pick("status");
  if (status !== undefined) out.status = status;
  const repo = pick("repo");
  if (repo !== undefined) out.repo = repo;
  if (qs.get("needsAttention") === "1" || qs.get("needsAttention") === "true") {
    out.needsAttention = true;
  }
  const page = Number(qs.get("page"));
  if (Number.isInteger(page) && page >= 1) out.page = page;
  return out;
}

/**
 * Serialize applied filters to a query string; empty values are omitted and
 * page 1 is canonicalized away, so the first page has the shortest shareable
 * URL and Apply/Reset always land back on page 1.
 */
export function serializeIssuesQuery(filters: IssuesAppliedFilters): string {
  const qs = new URLSearchParams();
  if (filters.q?.trim()) qs.set("q", filters.q.trim());
  if (filters.status?.trim()) qs.set("status", filters.status.trim());
  if (filters.repo?.trim()) qs.set("repo", filters.repo.trim());
  if (filters.needsAttention) qs.set("needsAttention", "1");
  if (filters.page !== undefined && Number.isInteger(filters.page) && filters.page > 1) {
    qs.set("page", String(filters.page));
  }
  qs.sort();
  return qs.toString();
}

/** Apply reads the draft form and always resets to page 1. */
export function formToIssuesFilters(form: IssuesFilterForm): IssuesAppliedFilters {
  const out: IssuesAppliedFilters = {};
  if (form.q.trim()) out.q = form.q.trim();
  if (form.status.trim()) out.status = form.status.trim();
  if (form.repo.trim()) out.repo = form.repo.trim();
  if (form.needsAttention) out.needsAttention = true;
  return out;
}

/**
 * Previous/Next navigate from the applied URL query with only `page` changed:
 * draft form edits are never applied, and no other param is touched. Page 1
 * is canonicalized away (omitted).
 */
export function setIssuesPageQuery(search: string, page: number): string {
  const qs = new URLSearchParams(strip(search));
  if (page <= 1) qs.delete("page");
  else qs.set("page", String(Math.floor(page)));
  qs.sort();
  return qs.toString();
}

export interface IssuesPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** "Showing 1–25 of 60 issues" or the filter-specific empty state. */
export function issuesRangeText(p: IssuesPagination): string {
  if (p.total === 0) return "No issues match these filters";
  const start = (p.page - 1) * p.limit + 1;
  const end = Math.min(p.total, p.page * p.limit);
  return `Showing ${start}–${end} of ${p.total} issues`;
}

export function issuesPageText(p: IssuesPagination): string {
  if (p.totalPages <= 1) return "";
  return `Page ${p.page} of ${p.totalPages}`;
}

/** True when any applied filter narrows the list (page excluded). */
export function hasActiveIssuesFilters(filters: IssuesAppliedFilters): boolean {
  return Boolean(filters.q || filters.status || filters.repo || filters.needsAttention);
}
