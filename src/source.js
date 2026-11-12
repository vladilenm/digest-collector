import { NewsletterIssueSchema } from "./newsletter-contract.js";
import { Pool } from "pg";
import { PublishedDigestSchema } from "./contract.js";
import { postgresOptions } from "./postgres.js";

export function normalizePublishedDigest(
  input,
  { topicId, digestId, publicationDate } = {},
) {
  const document = PublishedDigestSchema.parse(input);
  if (
    (topicId && document.topic.id !== topicId) ||
    (digestId && document.digestId !== digestId) ||
    (publicationDate && document.publicationDate !== publicationDate)
  )
    throw new Error("digest_identity_mismatch");
  const events =
    document.schemaVersion === 4
      ? document.items
      : [
          ...document.sections.main,
          ...document.sections.radar,
          ...document.sections.focus,
        ].map((event) => ({
          eventId: event.eventId,
          title: event.title,
          claimKind: event.claimKind,
          tags: event.tags,
          sources: event.sources,
          publishedAt: event.publishedAt,
          body: [event.summary, event.whyImportant, event.affected].map(
            (text) => ({ type: "paragraph", spans: [{ text }] }),
          ),
        }));
  return {
    digestId: document.digestId,
    topicId: document.topic.id,
    title: document.topic.title,
    publicationDate: document.publicationDate,
    items: events,
  };
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function createDigestReader(
  config,
  { pool: injectedPool, createPool = (options) => new Pool(options) } = {},
) {
  let pool = injectedPool;
  const configured = Boolean(
    config.topicId && (config.digestDatabaseUrl || injectedPool),
  );
  const getPool = () => {
    if (!pool) {
      pool = createPool(
        postgresOptions(config.digestDatabaseUrl, {
          ssl: config.digestDatabaseSsl,
          network: config.digestDatabaseNetwork,
        }),
      );
      pool.on("error", () => console.warn("newsletter_digest_connection_lost"));
    }
    return pool;
  };
  const mapRow = (row) =>
    normalizeNewsletter(row.document, {
      topicId: config.topicId,
      issueId: row.issue_id,
      fromDate: row.from_date,
      toDate: row.to_date,
    });
  return {
    configured,
    async range({ fromDate, toDate }) {
      if (
        !validDate(fromDate) ||
        !validDate(toDate) ||
        fromDate > toDate ||
        Date.parse(toDate) - Date.parse(fromDate) > 7 * 86400000
      )
        throw new Error("invalid_digest_window");
      if (!configured) return [];
      const { rows } = await getPool().query(
        `SELECT issue_id, from_date::text, to_date::text, document
        FROM digest.newsletter_issue_source_v1 WHERE topic_id = $1
          AND from_date = $2::date AND to_date = $3::date
          AND issue_type = 'email-period' AND schema_version = 1`,
        [config.topicId, fromDate, toDate],
      );
      if (rows.length > 1) throw new Error("ambiguous_newsletter_period");
      return rows.map((row) => {
        if (row.from_date !== fromDate || row.to_date !== toDate) throw new Error("newsletter_period_mismatch");
        return mapRow(row);
      });
    },
    async close() {
      if (pool && !injectedPool) await pool.end();
    },
  };
}

export function normalizeNewsletter(input, { topicId, issueId, fromDate, toDate } = {}) {
  const document = NewsletterIssueSchema.parse(input);
  if ((topicId && document.topic.id !== topicId) || (issueId && document.issueId !== issueId) ||
      (fromDate && document.period.fromDate !== fromDate) || (toDate && document.period.toDate !== toDate))
    throw new Error("newsletter_identity_mismatch");
  return document;
}
