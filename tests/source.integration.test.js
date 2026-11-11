import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { createDigestReader } from "../src/source.js";
const url = process.env.NEWSLETTER_TEST_DATABASE_URL;

test(
  "published digest reader works through a topic-filtered read-only PostgreSQL view",
  { skip: !url },
  async () => {
    // This test owns its data and must never run against the club's working DB.
    assert.match(new URL(url).pathname, /_test$/);
    const owner = new pg.Pool({ connectionString: url });
    let readerPool;
    try {
      await owner.query("CREATE SCHEMA IF NOT EXISTS digest");
      await owner.query(
        "CREATE TABLE IF NOT EXISTS digest.newsletter_reader_test_issues (digest_id uuid PRIMARY KEY,topic_id text NOT NULL,publication_date date NOT NULL,generated_at timestamptz NOT NULL,document jsonb NOT NULL)",
      );
      await owner.query("TRUNCATE digest.newsletter_reader_test_issues");
      // Only the disposable test view is replaced; no production endpoint is used.
      await owner.query(
        "CREATE OR REPLACE VIEW digest.published_issue_source AS SELECT * FROM digest.newsletter_reader_test_issues",
      );
      const fixture = JSON.parse(
        await readFile(
          new URL("./fixtures/published-digest-v4.json", import.meta.url),
          "utf8",
        ),
      );
      await owner.query(
        "INSERT INTO digest.newsletter_reader_test_issues VALUES($1,$2,$3,$4,$5)",
        [
          fixture.digestId,
          fixture.topic.id,
          fixture.publicationDate,
          fixture.generatedAt,
          fixture,
        ],
      );
      const other = structuredClone(fixture);
      other.digestId = "00000000-0000-4000-8000-000000000099";
      other.topic.id = "another";
      await owner.query(
        "INSERT INTO digest.newsletter_reader_test_issues VALUES($1,$2,$3,$4,$5)",
        [
          other.digestId,
          other.topic.id,
          other.publicationDate,
          other.generatedAt,
          other,
        ],
      );
      await owner.query(
        "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='codex_newsletter_reader_test') THEN CREATE ROLE codex_newsletter_reader_test LOGIN PASSWORD 'local-reader-test-only'; END IF; END $$",
      );
      await owner.query(
        "GRANT USAGE ON SCHEMA digest TO codex_newsletter_reader_test",
      );
      await owner.query(
        "REVOKE ALL ON digest.newsletter_reader_test_issues FROM PUBLIC, codex_newsletter_reader_test",
      );
      await owner.query(
        "GRANT SELECT ON digest.published_issue_source TO codex_newsletter_reader_test",
      );
      const readerUrl = new URL(url);
      readerUrl.username = "codex_newsletter_reader_test";
      readerUrl.password = "local-reader-test-only";
      readerPool = new pg.Pool({ connectionString: readerUrl.href });
      const reader = createDigestReader(
        { topicId: fixture.topic.id },
        { pool: readerPool },
      );
      const issues = await reader.range({
        fromDate: fixture.publicationDate,
        toDate: fixture.publicationDate,
      });
      assert.equal(issues.length, 1);
      assert.equal(issues[0].topicId, fixture.topic.id);
      await assert.rejects(
        readerPool.query("SELECT * FROM digest.newsletter_reader_test_issues"),
        (e) => e.code === "42501",
      );
      await assert.rejects(
        readerPool.query("DELETE FROM digest.published_issue_source"),
        (e) => e.code === "42501",
      );
    } finally {
      await readerPool?.end();
      await owner.end();
    }
  },
);
