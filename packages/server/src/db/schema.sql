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
  run_id TEXT NOT NULL REFERENCES runs(id),
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
