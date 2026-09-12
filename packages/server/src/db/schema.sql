CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  deck_id TEXT,
  deck_name TEXT,
  playbook_id TEXT,
  workspace_root TEXT,
  default_plan_model TEXT,
  default_execute_model TEXT,
  default_plan_budget_json TEXT,
  default_execute_budget_json TEXT,
  default_model TEXT,
  default_budget_json TEXT,
  purpose TEXT,
  playbook_ids_json TEXT,
  external_memory_refs_json TEXT,
  permission_policy_json TEXT,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT,
  external_label TEXT,
  task_category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  repo TEXT,
  artifact_workspace TEXT,
  agent_id TEXT REFERENCES agents(id),
  agent_name TEXT,
  deck_id TEXT,
  deck_name TEXT,
  playbook_id TEXT,
  runtime TEXT,
  plan_model TEXT,
  execute_model TEXT,
  status TEXT NOT NULL,
  lineage_id TEXT,
  acceptance_criteria TEXT,
  approval_gates_json TEXT,
  budget_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_external ON runs(source, external_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  -- Nullable: issue-linked artifacts (issue_id column, added below by migrate()) have no
  -- run — only legacy run-scoped artifacts populate run_id. See NOT-57 Task 1 amendment.
  run_id TEXT REFERENCES runs(id),
  kind TEXT NOT NULL,
  content_json TEXT,
  blob_path TEXT,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  type TEXT NOT NULL,
  payload_json TEXT,
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);

CREATE TABLE IF NOT EXISTS approval_gates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_gates_run ON approval_gates(run_id);

CREATE TABLE IF NOT EXISTS intake_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT,
  external_label TEXT,
  external_url TEXT,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,
  repo TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  status TEXT NOT NULL,
  current_owner TEXT NOT NULL,
  current_intent TEXT,
  developer_agent_id TEXT REFERENCES agents(id),
  reviewer_agent_id TEXT REFERENCES agents(id),
  max_review_rounds INTEGER NOT NULL DEFAULT 3,
  current_round INTEGER NOT NULL DEFAULT 1,
  max_infra_attempts INTEGER NOT NULL DEFAULT 3,
  infra_attempts INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  base_sha TEXT,
  head_sha TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_external ON issues(source, external_id);

CREATE TABLE IF NOT EXISTS worker_sessions (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  role TEXT NOT NULL,
  round INTEGER NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  runtime TEXT,
  model TEXT,
  budget_json TEXT,
  worktree_path TEXT,
  input_sha TEXT,
  status TEXT NOT NULL,
  session_ref TEXT,
  log_path TEXT,
  exit_code INTEGER,
  error_json TEXT,
  metadata_json TEXT,
  profile_snapshot_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  heartbeat_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worker_sessions_issue ON worker_sessions(issue_id);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_status ON worker_sessions(status);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  workflow_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_issue ON workflow_instances(issue_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_instances_one_active
  ON workflow_instances(issue_id) WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  workflow_instance_id TEXT REFERENCES workflow_instances(id),
  worker_session_id TEXT REFERENCES worker_sessions(id),
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_ref TEXT,
  stage TEXT NOT NULL,
  round INTEGER,
  payload_json TEXT,
  artifact_ref TEXT,
  idempotency_key TEXT,
  causation_event_id TEXT REFERENCES workflow_events(id),
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_issue ON workflow_events(issue_id, ts);
-- Provider-native idempotency key is unique: re-ingesting the same delivery must not
-- create a duplicate event (PRD §9.3).
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_events_idempotency ON workflow_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS human_actions (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  workflow_instance_id TEXT REFERENCES workflow_instances(id),
  action_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  question TEXT NOT NULL,
  evidence_json TEXT,
  response_options_json TEXT,
  continuation_preview_json TEXT,
  status TEXT NOT NULL,
  resolution_json TEXT,
  resolved_by TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_human_actions_issue ON human_actions(issue_id);
CREATE INDEX IF NOT EXISTS idx_human_actions_status ON human_actions(status);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_ref TEXT,
  file TEXT,
  line INTEGER,
  status TEXT NOT NULL,
  first_round INTEGER NOT NULL,
  last_round INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_findings_issue ON findings(issue_id);
CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings(issue_id, fingerprint);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  worker_session_id TEXT NOT NULL REFERENCES worker_sessions(id),
  role TEXT NOT NULL,
  runtime TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_issue ON usage_events(issue_id);

-- NOT-59: the coordinator kernel's durable work-item / outbox. Each applied coordinator
-- command records the state transition, the workflow event, and exactly one next work
-- item in one transaction; a leased effect worker claims a work item, refreshes a
-- heartbeat, and its structured completion is applied in a second transaction. No event
-- sourcing or queue broker — SQLite plus this table is sufficient (design §"Accepted
-- architecture" point 3).
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  workflow_instance_id TEXT NOT NULL REFERENCES workflow_instances(id),
  worker_session_id TEXT REFERENCES worker_sessions(id),
  kind TEXT NOT NULL,                 -- 'developer' | 'reviewer'
  round INTEGER NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL,               -- pending | leased | done | dead | cancelled
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_token TEXT,                   -- fencing token: rotated on every claim/reclaim
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  available_at TEXT NOT NULL,         -- backoff gate; <= now ⇒ claimable
  idempotency_key TEXT,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_items_claimable ON work_items(status, available_at);
-- A retried callback, poll, or restart must not enqueue the same next effect twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_idempotency ON work_items(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Structural guarantee that duplicate dispatch can't leave two "next" effects outstanding
-- for one workflow instance (design: "exactly one next effect").
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_one_active ON work_items(workflow_instance_id)
  WHERE status IN ('pending', 'leased');

-- A durable claim + result for the reviewer effect's GitHub publication (NOT-62 review
-- rounds 2-3). Unlike a push, a `gh pr review` submission is not naturally idempotent,
-- and a read-only "does a review already exist" check alone is a check-then-publish
-- race: two overlapping attempts on the same work item (a crash-and-recover, or a
-- genuine zombie still running past its reclaimed lease) could both read "not found"
-- before either has published. One row per work item is inserted here atomically before
-- either attempt is allowed to call `gh` — whichever insert wins the primary key is the
-- only attempt allowed to publish. Critically, the row also carries the *actual*
-- normalized result that was published (`result_json`/`event`): a losing attempt that
-- ran its own independent reviewer session must report what its rival actually
-- published, never its own (possibly different) locally-parsed verdict — round 3 found
-- exactly this gap ("GitHub and workflow state can disagree" when the two sessions
-- disagree). `state` lets a loser distinguish "still in flight, wait" from "published,
-- take its result" from "the winner failed, safe to reclaim and retry."
CREATE TABLE IF NOT EXISTS review_publications (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  state TEXT NOT NULL,             -- 'claimed' | 'published' | 'failed'
  result_json TEXT,                -- the ReviewerResult actually published (state = 'published')
  event TEXT,                      -- the ReviewEvent actually published
  used_comment_fallback INTEGER,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
