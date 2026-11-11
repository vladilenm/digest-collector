CREATE TABLE IF NOT EXISTS newsletter.unisender_campaigns (
  topic_id text NOT NULL,
  list_id integer NOT NULL CHECK (list_id > 0),
  send_date date NOT NULL,
  mode text NOT NULL CHECK (mode IN ('test', 'public')),
  from_date date NOT NULL CHECK (from_date = send_date - 3),
  to_date date NOT NULL CHECK (to_date = send_date - 1),
  state text NOT NULL DEFAULT 'preparing'
    CHECK (state IN ('preparing', 'draft', 'sending', 'accepted', 'skipped', 'failed', 'uncertain')),
  issue_ids uuid[] NOT NULL DEFAULT '{}',
  content_hash text CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  message_id integer CHECK (message_id > 0),
  campaign_id integer CHECK (campaign_id > 0),
  provider_status text CHECK (provider_status IN ('scheduled', 'waits_censor')),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, list_id, send_date, mode),
  CHECK (state NOT IN ('draft', 'sending', 'accepted') OR
    (message_id IS NOT NULL AND content_hash IS NOT NULL AND cardinality(issue_ids) > 0)),
  CHECK (state <> 'accepted' OR (campaign_id IS NOT NULL AND provider_status IS NOT NULL))
);
REVOKE ALL ON TABLE newsletter.unisender_campaigns FROM PUBLIC;
