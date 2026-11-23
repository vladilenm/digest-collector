ALTER TABLE newsletter.unisender_campaigns
  ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  ADD COLUMN attempt_started_at timestamptz,
  ADD COLUMN delivered_count integer CHECK (delivered_count >= 0),
  ADD COLUMN stats_checked_at timestamptz,
  ADD COLUMN stats_attempted_at timestamptz,
  ADD COLUMN report_url text,
  ADD COLUMN rejection_code text CHECK (rejection_code IN ('invalid_api_key','access_denied','unknown_method',
    'invalid_arg','not_enough_money','api_call_limit_exceeded_for_api_key','api_call_limit_exceeded_for_ip')),
  DROP CONSTRAINT unisender_campaigns_provider_status_check,
  ADD CHECK (provider_status IN ('waits_censor', 'censor_hold', 'declined', 'waits_schedule',
    'scheduled', 'in_progress', 'analysed', 'completed', 'stopped', 'canceled'));
UPDATE newsletter.unisender_campaigns SET attempt_started_at = created_at;
ALTER TABLE newsletter.unisender_campaigns
  ALTER COLUMN attempt_started_at SET DEFAULT now(),
  ALTER COLUMN attempt_started_at SET NOT NULL;

CREATE TABLE newsletter.operator_requests (
  id uuid PRIMARY KEY,
  topic_id text NOT NULL,
  list_id integer NOT NULL CHECK (list_id > 0),
  mode text NOT NULL CHECK (mode IN ('public', 'test')),
  send_date date NOT NULL,
  action text NOT NULL CHECK (action IN ('send', 'check')),
  retry_attempt integer NOT NULL DEFAULT 0 CHECK (retry_attempt >= 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  result_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (retry_attempt = 0 OR action = 'send')
);
CREATE UNIQUE INDEX operator_requests_active ON newsletter.operator_requests
  (topic_id, list_id, mode, send_date) WHERE state IN ('queued','running');

CREATE TABLE newsletter.sender_health (
  topic_id text NOT NULL,
  list_id integer NOT NULL CHECK (list_id > 0),
  mode text NOT NULL CHECK (mode IN ('public', 'test')),
  seen_at timestamptz NOT NULL DEFAULT now(),
  available_since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, list_id, mode)
);
REVOKE ALL ON newsletter.operator_requests, newsletter.sender_health FROM PUBLIC;
