import pg from "pg";
import { createDigestReader } from "../source.js";

const one = async (pool, sql, params) =>
  (await pool.query(sql, params)).rows[0] || null;

export function createControlStore(config, source, journal) {
  const reader = createDigestReader(
    { topicId: config.topic },
    { pool: source },
  );
  const key = (date) => [config.topic, config.listId, config.mode, date];
  async function readPreparation(period) {
    const params = [config.topic, period.sendDate];
    const [issues, preparation, heartbeat, request, lastSuccess] =
      await Promise.all([
        reader.range(period),
        one(
          source,
          "SELECT state,error_code,started_at,updated_at,last_success_at FROM digest.newsletter_preparation WHERE topic_id=$1 AND send_date=$2",
          params,
        ),
        one(
          source,
          "SELECT seen_at FROM digest.newsletter_producer_health WHERE topic_id=$1",
          [config.topic],
        ),
        one(
          source,
          `SELECT state,error_code,updated_at FROM digest.newsletter_prepare_requests
        WHERE topic_id=$1 AND send_date=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
          params,
        ),
        one(
          source,
          `SELECT max(last_success_at) AS at FROM digest.newsletter_preparation
        WHERE topic_id=$1 AND send_date <= $2`,
          params,
        ),
      ]);
    return {
      issue: issues[0] || null,
      preparation,
      heartbeat,
      request,
      lastSuccess: lastSuccess?.at,
    };
  }
  async function readDelivery(period) {
    const params = key(period.sendDate);
    const [campaign, heartbeat, request] = await Promise.all([
      one(
        journal,
        `SELECT state,failure_code,rejection_code,message_id,campaign_id,provider_status,updated_at,
        attempt,delivered_count,stats_checked_at,report_url FROM newsletter.unisender_campaigns
        WHERE topic_id=$1 AND list_id=$2 AND mode=$3 AND send_date=$4`,
        params,
      ),
      one(
        journal,
        `SELECT seen_at FROM newsletter.sender_health WHERE topic_id=$1 AND list_id=$2 AND mode=$3`,
        params.slice(0, 3),
      ),
      one(
        journal,
        `SELECT action,state,result_code,updated_at FROM newsletter.operator_requests
        WHERE topic_id=$1 AND list_id=$2 AND mode=$3 AND send_date=$4 ORDER BY created_at DESC,id DESC LIMIT 1`,
        params,
      ),
    ]);
    return { campaign, heartbeat, request };
  }
  return {
    async read(period) {
      const [p, s] = await Promise.allSettled([
        readPreparation(period),
        readDelivery(period),
      ]);
      return {
        prep: p.status === "fulfilled" ? p.value : null,
        sender: s.status === "fulfilled" ? s.value : null,
      };
    },
    async issue(period) {
      return (await reader.range(period))[0] || null;
    },
    async enqueue({ id, action, sendDate, retryAttempt }) {
      if (action === "prepare") {
        await source.query(
          `INSERT INTO digest.newsletter_prepare_requests(id,topic_id,send_date)
          VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [id, config.topic, sendDate],
        );
      } else {
        await journal.query(
          `INSERT INTO newsletter.operator_requests(id,topic_id,list_id,mode,send_date,action,retry_attempt)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [id, ...key(sendDate), action, retryAttempt],
        );
      }
    },
  };
}

export function connectControlStore(config) {
  function pool(connection) {
    const p = new pg.Pool({
      ...connection,
      max: 6,
      statement_timeout: 5000,
      query_timeout: 6500,
    });
    p.on("error", () => console.error("control_database_unavailable"));
    return p;
  }
  const source = pool(config.sourceDb),
    journal = pool(config.journalDb);
  return {
    ...createControlStore(config, source, journal),
    close: () => Promise.all([source.end(), journal.end()]),
  };
}
