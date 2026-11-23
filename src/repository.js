const allowed = {
  preparing: ["preparing", "draft", "skipped", "failed", "uncertain"],
  draft: ["sending", "failed"],
  sending: ["accepted", "failed", "uncertain"],
};
const identity = ({ topicId, listId, sendDate, mode }) => [topicId, listId, sendDate, mode];

export function createUnisenderCampaignRepository(pool, { controlEnabled = false } = {}) {
  return {
    async isClaimed(key) {
      const result = await pool.query(
        "SELECT 1 FROM newsletter.unisender_campaigns WHERE topic_id=$1 AND list_id=$2 AND send_date=$3 AND mode=$4",
        identity(key),
      );
      return result.rowCount > 0;
    },
    async claim(key) {
      const result = await pool.query(
        `INSERT INTO newsletter.unisender_campaigns (topic_id, list_id, send_date, mode, from_date, to_date)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING state`,
        [...identity(key), key.fromDate, key.toDate],
      );
      return result.rowCount === 1;
    },
    async claimRejected(key, retryAttempt) {
      if (!Number.isSafeInteger(retryAttempt) || retryAttempt < 1) return false;
      const result = await pool.query(
        `UPDATE newsletter.unisender_campaigns SET state = 'preparing', attempt = attempt + 1,
          attempt_started_at = now(), updated_at = now(), issue_ids = '{}', content_hash = NULL,
          message_id = NULL, provider_status = NULL, failure_code = NULL, rejection_code = NULL,
          delivered_count = NULL, stats_checked_at = NULL, stats_attempted_at = NULL, report_url = NULL
        WHERE topic_id=$1 AND list_id=$2 AND send_date=$3 AND mode=$4 AND attempt=$5
          AND state='failed' AND failure_code='unisender_rejected' AND campaign_id IS NULL`,
        [...identity(key), retryAttempt],
      );
      return result.rowCount === 1;
    },
    async transition(key, state, next, {
      issueIds = null, contentHash = null, messageId = null, campaignId = null,
      providerStatus = null, failureCode = null, rejectionCode = null,
    } = {}) {
      if (!allowed[state]?.includes(next)) throw new Error("invalid_campaign_transition");
      const recordReason = controlEnabled && rejectionCode;
      const result = await pool.query(
        `UPDATE newsletter.unisender_campaigns SET
          state = $6, issue_ids = CASE WHEN content_hash IS NULL THEN COALESCE($7::uuid[], issue_ids) ELSE issue_ids END,
          content_hash = COALESCE(content_hash, $8), message_id = COALESCE(message_id, $9),
          campaign_id = COALESCE(campaign_id, $10), provider_status = COALESCE(provider_status, $11),
          failure_code = COALESCE($12, failure_code), updated_at = now()
          ${recordReason ? ", rejection_code = $13" : ""}
        WHERE topic_id = $1 AND list_id = $2 AND send_date = $3 AND mode = $4 AND state = $5
          AND ($6 <> 'preparing' OR content_hash IS NULL)`,
        [...identity(key), state, next, issueIds, contentHash, messageId, campaignId, providerStatus, failureCode,
          ...(recordReason ? [rejectionCode] : [])],
      );
      if (result.rowCount !== 1) throw new Error("campaign_state_changed");
    },
  };
}
