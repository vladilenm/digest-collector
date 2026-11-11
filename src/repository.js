const allowed = {
  preparing: ["preparing", "draft", "skipped", "failed", "uncertain"],
  draft: ["sending", "failed"],
  sending: ["accepted", "failed", "uncertain"],
};
const identity = ({ topicId, listId, sendDate, mode }) => [topicId, listId, sendDate, mode];

export function createUnisenderCampaignRepository(pool) {
  return {
    async claim(key) {
      const result = await pool.query(
        `INSERT INTO newsletter.unisender_campaigns (topic_id, list_id, send_date, mode, from_date, to_date)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING state`,
        [...identity(key), key.fromDate, key.toDate],
      );
      return result.rowCount === 1;
    },
    async transition(key, state, next, {
      issueIds = null, contentHash = null, messageId = null, campaignId = null,
      providerStatus = null, failureCode = null,
    } = {}) {
      if (!allowed[state]?.includes(next)) throw new Error("invalid_campaign_transition");
      const result = await pool.query(
        `UPDATE newsletter.unisender_campaigns SET
          state = $6, issue_ids = CASE WHEN content_hash IS NULL THEN COALESCE($7::uuid[], issue_ids) ELSE issue_ids END,
          content_hash = COALESCE(content_hash, $8), message_id = COALESCE(message_id, $9),
          campaign_id = COALESCE(campaign_id, $10), provider_status = COALESCE(provider_status, $11),
          failure_code = COALESCE($12, failure_code), updated_at = now()
        WHERE topic_id = $1 AND list_id = $2 AND send_date = $3 AND mode = $4 AND state = $5
          AND ($6 <> 'preparing' OR content_hash IS NULL)`,
        [...identity(key), state, next, issueIds, contentHash, messageId, campaignId, providerStatus, failureCode],
      );
      if (result.rowCount !== 1) throw new Error("campaign_state_changed");
    },
  };
}
