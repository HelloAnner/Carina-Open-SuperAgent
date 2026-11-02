-- Carina initial schema

CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domains (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_instances (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  domain_id text NOT NULL REFERENCES domains(id),
  kind text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_instances_domain_idx ON source_instances(domain_id);

CREATE TABLE IF NOT EXISTS triggers (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain_id text NOT NULL,
  source_instance_id text NOT NULL,
  source_kind text NOT NULL,
  source_event_id text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  object_version text,
  actor jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  thread_keys jsonb NOT NULL,
  causation_id text,
  correlation_id text,
  content_type text NOT NULL,
  summary text NOT NULL,
  channel jsonb,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS triggers_source_event_uidx ON triggers(source_instance_id, source_event_id);
CREATE INDEX IF NOT EXISTS triggers_domain_thread_idx ON triggers(domain_id, occurred_at);

CREATE TABLE IF NOT EXISTS trigger_dispositions (
  trigger_id text PRIMARY KEY REFERENCES triggers(id),
  kind text NOT NULL,
  reason text,
  eval_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS threads (
  key text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain_id text NOT NULL,
  source_instance_id text NOT NULL,
  source_kind text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  last_trigger_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS threads_domain_idx ON threads(domain_id);

CREATE TABLE IF NOT EXISTS thread_subscriptions (
  id text PRIMARY KEY,
  thread_key text NOT NULL REFERENCES threads(key),
  task_id text NOT NULL,
  purpose text NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_subscriptions_uidx ON thread_subscriptions(thread_key, task_id);
CREATE INDEX IF NOT EXISTS thread_subscriptions_task_idx ON thread_subscriptions(task_id);

CREATE TABLE IF NOT EXISTS router_inbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain_id text NOT NULL,
  thread_key text NOT NULL,
  trigger_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS router_inbox_claim_idx ON router_inbox(domain_id, state, available_at);
CREATE UNIQUE INDEX IF NOT EXISTS router_inbox_trigger_uidx ON router_inbox(trigger_id);

CREATE TABLE IF NOT EXISTS evaluations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain_id text NOT NULL,
  thread_key text NOT NULL,
  trigger_ids jsonb NOT NULL,
  policy_version text NOT NULL,
  status text NOT NULL,
  decision jsonb,
  model text,
  tokens_in integer,
  tokens_out integer,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain_id text NOT NULL,
  title text NOT NULL,
  scope text NOT NULL,
  acceptance text NOT NULL,
  state text NOT NULL,
  mandate jsonb NOT NULL,
  origin_trigger_id text NOT NULL,
  plan_version integer NOT NULL DEFAULT 1,
  budget jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_domain_state_idx ON tasks(domain_id, state);
CREATE INDEX IF NOT EXISTS tasks_origin_trigger_idx ON tasks(origin_trigger_id);

CREATE TABLE IF NOT EXISTS assignments (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  attempt integer NOT NULL,
  runtime_type text NOT NULL,
  state text NOT NULL,
  fencing_token integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  ended_at timestamptz,
  result text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assignments_task_idx ON assignments(task_id);
CREATE INDEX IF NOT EXISTS assignments_claim_idx ON assignments(state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS assignments_task_attempt_uidx ON assignments(task_id, attempt);

CREATE TABLE IF NOT EXISTS worker_sessions (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  assignment_id text NOT NULL REFERENCES assignments(id),
  runtime_type text NOT NULL,
  state text NOT NULL,
  workspace_ref text,
  resume_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_inputs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  assignment_id text,
  kind text NOT NULL,
  trigger_id text,
  text text,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS worker_inputs_task_idx ON worker_inputs(task_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS worker_inputs_task_trigger_uidx ON worker_inputs(task_id, trigger_id) WHERE trigger_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_events_session_idx ON session_events(session_id, id);

CREATE TABLE IF NOT EXISTS reports (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  assignment_id text NOT NULL,
  kind text NOT NULL,
  body text NOT NULL,
  evidence jsonb,
  unresolved jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain_id text NOT NULL,
  channel jsonb NOT NULL,
  text text NOT NULL,
  kind text NOT NULL,
  idem_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_idem_uidx ON outbox(idem_key);
CREATE INDEX IF NOT EXISTS outbox_claim_idx ON outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain_id text NOT NULL,
  task_id text,
  kind text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_records (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain_id text NOT NULL,
  task_id text,
  model text NOT NULL,
  tokens_in integer NOT NULL,
  tokens_out integer NOT NULL,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain_id text,
  actor jsonb NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_router_state (
  domain_id text PRIMARY KEY,
  fencing_token integer NOT NULL DEFAULT 0,
  lease_until timestamptz
);

CREATE TABLE IF NOT EXISTS watch_alerts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain_id text NOT NULL,
  task_id text,
  kind text NOT NULL,
  severity text NOT NULL,
  state text NOT NULL,
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
