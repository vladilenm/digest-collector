import { setTimeout as sleep } from "node:timers/promises";
import { UnisenderError } from "./client.js";

const scope = "topic_id=$1 AND list_id=$2 AND mode=$3";
const fresh = "now() - interval '90 seconds'";
const done = new Set(["accepted", "already_claimed", "skipped", "checked", "report_pending"]);
const inspectable = "('preparing','draft','sending','uncertain','accepted','failed')";
const campaignColumns =
  "send_date::text, state, attempt, attempt_started_at, message_id, campaign_id, report_url, stats_attempted_at::text AS stats_token";

export function createSenderControlRepository(pool, { topicId, listId, mode }) {
  const keys = [topicId, listId, mode];
  const query = (sql, ...args) => pool.query(sql, [...keys, ...args]);
  return {
    async pulse(requestId) {
      // A recovered heartbeat starts a new availability window. Queue entries from
      // before the outage cannot become actionable when the process returns.
      await query(`INSERT INTO newsletter.sender_health AS h (topic_id,list_id,mode) VALUES ($1,$2,$3)
        ON CONFLICT (topic_id,list_id,mode) DO UPDATE SET seen_at=now(),
          available_since=CASE WHEN h.seen_at < ${fresh} THEN now() ELSE h.available_since END`);
      await query(`UPDATE newsletter.operator_requests SET state='failed', updated_at=now(),
        result_code=CASE state WHEN 'queued' THEN 'worker_stale' ELSE 'worker_interrupted' END
        WHERE ${scope} AND state IN ('queued','running') AND
          ((action='send' AND created_at < (SELECT available_since FROM newsletter.sender_health WHERE ${scope}))
           OR (state='queued' AND action='send' AND created_at < ${fresh})
           OR (state='running' AND updated_at < ${fresh}))`);
      if (requestId)
        await query(
          `UPDATE newsletter.operator_requests SET updated_at=now()
        WHERE ${scope} AND id=$4 AND state='running' AND updated_at >= ${fresh}`,
          requestId,
        );
    },
    async take() {
      const result = await query(`WITH picked AS (
        SELECT id FROM newsletter.operator_requests WHERE ${scope} AND state='queued'
        AND EXISTS (SELECT 1 FROM newsletter.sender_health h WHERE ${scope} AND h.seen_at >= ${fresh}
          AND (action='check' OR (created_at >= h.available_since AND created_at >= ${fresh})))
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE newsletter.operator_requests r SET state='running', updated_at=now()
        FROM picked WHERE r.id=picked.id RETURNING r.id,r.send_date::text,r.retry_attempt,r.action`);
      return result.rows[0];
    },
    async active(id) {
      const result = await query(
        `SELECT 1 FROM newsletter.operator_requests r
        JOIN newsletter.sender_health h USING(topic_id,list_id,mode)
        WHERE ${scope} AND r.id=$4 AND r.state='running' AND r.updated_at >= ${fresh}
        AND h.seen_at >= ${fresh} AND r.created_at >= h.available_since`,
        id,
      );
      return result.rowCount === 1;
    },
    async finish(id, code) {
      await query(
        `UPDATE newsletter.operator_requests SET state=$5,result_code=$6,updated_at=now()
        WHERE ${scope} AND id=$4 AND state='running'`,
        id,
        done.has(code) ? "done" : "failed",
        code,
      );
    },
    async campaign(sendDate) {
      // A later check supersedes an in-flight older snapshot, including a stale
      // delivery count obtained after a newer check has already completed.
      const result = await query(
        `UPDATE newsletter.unisender_campaigns SET stats_attempted_at=clock_timestamp()
        WHERE ${scope} AND send_date=$4 AND state IN ${inspectable} RETURNING ${campaignColumns}`,
        sendDate,
      );
      return result.rows[0];
    },
    async nextReport() {
      // Reserve before the API call, so a provider outage or overlapping workers
      // cannot repeatedly poll one campaign. Explicit operator checks remain available.
      const result = await query(`WITH picked AS (
        SELECT send_date FROM newsletter.unisender_campaigns WHERE ${scope}
          AND state='accepted'
          AND ((provider_status='completed' AND final_stats_checked_at IS NULL)
            OR (provider_status <> 'completed' AND attempt_started_at >= now() - interval '7 days'))
          AND (stats_attempted_at IS NULL OR stats_attempted_at < now() -
            CASE WHEN attempt_started_at < now() - interval '7 days' THEN interval '1 day' ELSE interval '15 minutes' END)
        ORDER BY stats_attempted_at NULLS FIRST, send_date DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE newsletter.unisender_campaigns SET stats_attempted_at=clock_timestamp() WHERE ${scope}
        AND send_date=(SELECT send_date FROM picked) RETURNING ${campaignColumns}`);
      return result.rows[0];
    },
    async recordStatus(row, campaignId, providerStatus, reportUrl) {
      const rejected = providerStatus === "declined" || providerStatus === "canceled";
      const result = await query(
        `UPDATE newsletter.unisender_campaigns SET campaign_id=$6,
        provider_status=$7, report_url=COALESCE($8, report_url), state=$9, failure_code=$10,
        final_stats_checked_at=CASE WHEN provider_status='completed' AND $7='completed' THEN final_stats_checked_at END,
        updated_at=now()
        WHERE ${scope} AND send_date=$4 AND attempt=$5 AND state IN ${inspectable}
          AND stats_attempted_at=$11::timestamptz AND (campaign_id IS NULL OR campaign_id=$6)
          AND message_id IS NOT NULL AND content_hash IS NOT NULL AND cardinality(issue_ids) > 0`,
        row.send_date,
        row.attempt,
        campaignId,
        providerStatus,
        reportUrl,
        rejected ? "failed" : "accepted",
        rejected ? `campaign_${providerStatus}` : null,
        row.stats_token,
      );
      return result.rowCount === 1;
    },
    async recordDelivered(row, campaignId, { delivered, sent }) {
      const result = await query(
        `UPDATE newsletter.unisender_campaigns SET delivered_count=COALESCE($7, delivered_count),sent_count=$9,
          stats_checked_at=CASE WHEN $7::integer IS NOT NULL THEN now() ELSE stats_checked_at END,
          has_observed_sends=has_observed_sends OR COALESCE($7 > 0,false) OR COALESCE($9::integer > 0,false),
          final_stats_checked_at=CASE WHEN provider_status='completed' AND $7 IS NOT NULL THEN now() ELSE final_stats_checked_at END
        WHERE ${scope} AND send_date=$4 AND attempt=$5 AND campaign_id=$6 AND stats_attempted_at=$8::timestamptz`,
        row.send_date,
        row.attempt,
        campaignId,
        delivered,
        row.stats_token,
        sent,
      );
      return result.rowCount === 1;
    },
  };
}

export async function reconcileCampaign({ row, control, client, listId, now = () => new Date() }) {
  if (!row) return "campaign_missing";
  if (!row.message_id || (row.state === "failed" && !row.campaign_id)) return "match_missing";
  let campaignId = row.campaign_id;
  let providerStatus;
  let reportUrl = row.report_url;
  const lookup = () =>
    client.findCampaign({
      campaignId,
      messageId: row.message_id,
      listId,
      // getCampaigns filters by UTC start time. Backfills run under today's
      // provider timestamp even when their original scheduled date is weeks old.
      from: new Date(new Date(row.attempt_started_at).getTime() - 86_400_000),
      to: new Date(now().getTime() + 86_400_000),
    });
  try {
    if (campaignId) {
      providerStatus = await client.campaignStatus(campaignId);
    } else {
      const match = await lookup();
      if (match.code !== "matched") return match.code;
      ({ campaignId, providerStatus, reportUrl } = match);
    }
    if (!(await control.recordStatus(row, campaignId, providerStatus, reportUrl))) return "campaign_changed";
    // Persist the association before a second provider request: delivery reports
    // can be temporarily unavailable while the campaign is already visible.
    const stats = await client.campaignStats(campaignId);
    if (
      (stats.delivered != null || stats.sent != null) &&
      !(await control.recordDelivered(row, campaignId, stats))
    )
      return "campaign_changed";
    if (!reportUrl && row.campaign_id) {
      // Report discovery is optional for a known ID. Failure must not erase
      // delivery counters or misclassify a successful statistics check.
      const match = await lookup().catch(() => null);
      if (match?.reportUrl) await control.recordStatus(row, campaignId, providerStatus, match.reportUrl);
    }
    return stats.delivered == null ? "report_pending" : "checked";
  } catch (error) {
    return error instanceof UnisenderError ? "provider_unavailable" : "journal_unavailable";
  }
}

export function createSenderControl({ config, control, publisher, client, onError, wait = sleep }) {
  let currentId;
  async function poll(signal) {
    const request = await control.take();
    if (request) {
      currentId = request.id;
      try {
        let code;
        if (request.action === "send") {
          const result = await publisher.tick({
            sendDate: request.send_date,
            retryAttempt: request.retry_attempt,
            signal,
            requestActive: () => control.active(request.id),
          });
          code = result.status;
        } else {
          const row = await control.campaign(request.send_date);
          code = await reconcileCampaign({ row, control, client, listId: config.listId });
        }
        await control.finish(request.id, code);
      } finally {
        currentId = undefined;
      }
      return;
    }
    const row = await control.nextReport();
    if (row) await reconcileCampaign({ row, control, client, listId: config.listId });
  }
  async function loop(task, delay, signal) {
    while (!signal.aborted) {
      try {
        await task(signal);
      } catch {
        onError("unisender_control_unavailable");
      }
      if (!signal.aborted) await wait(delay, undefined, { signal }).catch(() => {});
    }
  }
  return {
    async run(signal) {
      await Promise.all([loop(() => control.pulse(currentId), 15_000, signal), loop(poll, 5_000, signal)]);
    },
  };
}
