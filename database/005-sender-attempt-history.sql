ALTER TABLE newsletter.unisender_campaigns
  ADD COLUMN sent_count integer CHECK (sent_count >= 0),
  ADD COLUMN final_stats_checked_at timestamptz,
  ADD COLUMN has_observed_sends boolean NOT NULL DEFAULT false;
UPDATE newsletter.unisender_campaigns SET has_observed_sends=true WHERE delivered_count > 0;

CREATE TABLE newsletter.unisender_attempt_history (
  LIKE newsletter.unisender_campaigns INCLUDING CONSTRAINTS,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, list_id, send_date, mode, attempt)
);
REVOKE ALL ON newsletter.unisender_attempt_history FROM PUBLIC;
