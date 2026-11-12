import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { createDigestReader } from "../src/source.js";
const url = process.env.NEWSLETTER_TEST_DATABASE_URL;

test(
  "prepared newsletter reader works through a topic-filtered read-only PostgreSQL view",
  { skip: !url },
  async () => {
    // This test owns its data and must never run against the club's working DB.
    assert.match(new URL(url).pathname, /_test$/);
    const owner = new pg.Pool({ connectionString: url });
    let readerPool;
    try {
      await owner.query("CREATE SCHEMA IF NOT EXISTS digest");
      await owner.query(
        "CREATE TABLE IF NOT EXISTS digest.newsletter_reader_test_issues (issue_id uuid PRIMARY KEY,topic_id text NOT NULL,from_date date NOT NULL,to_date date NOT NULL,document jsonb NOT NULL,issue_type text DEFAULT 'email-period',schema_version int DEFAULT 1)",
      );
      await owner.query("TRUNCATE digest.newsletter_reader_test_issues");
      // Only the disposable test view is replaced; no production endpoint is used.
      await owner.query(
        "CREATE OR REPLACE VIEW digest.newsletter_issue_source_v1 AS SELECT * FROM digest.newsletter_reader_test_issues OFFSET 0",
      );
      const fixture = JSON.parse(
        await readFile(
          new URL("./fixtures/newsletter-issue-v1.json", import.meta.url),
          "utf8",
        ),
      );
      await owner.query(
        "INSERT INTO digest.newsletter_reader_test_issues(issue_id,topic_id,from_date,to_date,document) VALUES($1,$2,$3,$4,$5)",
        [
          fixture.issueId,
          fixture.topic.id,
          fixture.period.fromDate,
          fixture.period.toDate,
          fixture,
        ],
      );
      const other = structuredClone(fixture);
      other.issueId = "00000000-0000-4000-8000-000000000099";
      other.topic.id = "another";
      await owner.query(
        "INSERT INTO digest.newsletter_reader_test_issues(issue_id,topic_id,from_date,to_date,document) VALUES($1,$2,$3,$4,$5)",
        [
          other.issueId,
          other.topic.id,
          other.period.fromDate,
          other.period.toDate,
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
        "GRANT SELECT ON digest.newsletter_issue_source_v1 TO codex_newsletter_reader_test",
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
        fromDate: fixture.period.fromDate,
        toDate: fixture.period.toDate,
      });
      assert.equal(issues.length, 1);
      assert.equal(issues[0].topic.id, fixture.topic.id);
      await assert.rejects(
        readerPool.query("SELECT * FROM digest.newsletter_reader_test_issues"),
        (e) => e.code === "42501",
      );
      assert.equal((await readerPool.query("SELECT has_table_privilege(current_user, 'digest.newsletter_issue_source_v1', 'INSERT,UPDATE,DELETE') can_write")).rows[0].can_write, false);
      await assert.rejects(
        readerPool.query("DELETE FROM digest.newsletter_issue_source_v1"),
        (e) => ["42501", "55000"].includes(e.code),
      );
    } finally {
      await readerPool?.end();
      await owner.end();
    }
  },
);
