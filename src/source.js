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
    normalizePublishedDigest(row.document, {
      topicId: config.topicId,
      digestId: row.digest_id,
      publicationDate:
        typeof row.publication_date === "string"
          ? row.publication_date
          : row.publication_date?.toISOString().slice(0, 10),
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
        `SELECT digest_id, publication_date::text, document
        FROM digest.published_issue_source WHERE topic_id = $1
          AND publication_date >= $2::date AND publication_date <= $3::date
        ORDER BY publication_date DESC, generated_at DESC, digest_id DESC LIMIT 8`,
        [config.topicId, fromDate, toDate],
      );
      return rows.map(mapRow);
    },
    async close() {
      if (pool && !injectedPool) await pool.end();
    },
  };
}
