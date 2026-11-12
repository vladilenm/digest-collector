import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { createUnisenderCampaignRepository } from "../src/repository.js";

const url = process.env.NEWSLETTER_TEST_DATABASE_URL;
const key = { topicId: "ai", listId: 88, sendDate: "2026-11-10", fromDate: "2026-11-07", toDate: "2026-11-09", mode: "test" };
const fields = {
  issueIds: ["018f6e76-7b42-7d66-9c18-4ff1846b03aa"],
  contentHash: "a".repeat(64),
};

test("campaign journal claims once across connections, isolates test and public, and blocks crash retries", { skip: !url }, async () => {
  assert.match(new URL(url).pathname, /_test$/);
  const owner = new pg.Pool({ connectionString: url });
  const role = "codex_unisender_journal_test";
  let session;
  try {
    await owner.query("CREATE SCHEMA IF NOT EXISTS newsletter");
    const migration = await readFile(new URL("../database/003-unisender-campaigns.sql", import.meta.url), "utf8");
    // SQL fixtures use a disposable database; the numbered migration is also exercised by the CLI.
    await owner.query(migration);
    await owner.query("TRUNCATE newsletter.unisender_campaigns");
    await owner.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'codex_unisender_journal_test') THEN CREATE ROLE codex_unisender_journal_test; END IF; END $$",
    );
    const grants = await readFile(new URL("../database/unisender-grants.sql", import.meta.url), "utf8");
    await owner.query(grants.replaceAll(':"runtime_role"', role));
    session = await owner.connect();
    await session.query("SET ROLE codex_unisender_journal_test");
    const journal = createUnisenderCampaignRepository(session);
    const parallel = createUnisenderCampaignRepository(owner);
    assert.equal(await journal.isClaimed(key), false);
    const claims = await Promise.all([journal.claim(key), parallel.claim(key)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await journal.isClaimed(key), true);
    await journal.transition(key, "preparing", "preparing", fields);
    await journal.transition(key, "preparing", "draft", { messageId: 12 });
    await journal.transition(key, "draft", "sending");

    // A restarted process must not acquire a row abandoned at the last pre-send write.
    assert.equal(await parallel.claim(key), false);
    const row = (await session.query("SELECT state, issue_ids, content_hash, message_id FROM newsletter.unisender_campaigns WHERE mode = 'test'")).rows[0];
    assert.deepEqual(row, {
      state: "sending", issue_ids: fields.issueIds, content_hash: fields.contentHash, message_id: 12,
    });
    await assert.rejects(journal.transition(key, "draft", "sending"), /campaign_state_changed/);
    await journal.transition(key, "sending", "uncertain", { failureCode: "unisender_timeout" });
    assert.equal(await parallel.claim(key), false);
    const publicKey = { ...key, mode: "public" };
    assert.equal(await journal.claim(publicKey), true);
    assert.equal(await parallel.claim(publicKey), false);
    await journal.transition(publicKey, "preparing", "preparing", fields);
    await journal.transition(publicKey, "preparing", "draft", { messageId: 14 });
    await journal.transition(publicKey, "draft", "sending");
    await journal.transition(publicKey, "sending", "accepted", { campaignId: 15, providerStatus: "waits_censor" });
    await assert.rejects(journal.transition(publicKey, "sending", "uncertain"), /campaign_state_changed/);

    await assert.rejects(session.query("DELETE FROM newsletter.unisender_campaigns"), { code: "42501" });
    // Granting the journal role must not grant any producer schema access.
    const privilege = await session.query("SELECT has_schema_privilege(current_user, 'newsletter', 'CREATE') AS can_create");
    assert.equal(privilege.rows[0].can_create, false);
    const publicGrants = await owner.query("SELECT grantee FROM information_schema.table_privileges WHERE table_schema = 'newsletter' AND table_name = 'unisender_campaigns' AND grantee = 'PUBLIC'");
    assert.equal(publicGrants.rowCount, 0);
  } finally {
    if (session) {
      await session.query("RESET ROLE").finally(() => session.release());
    }
    await owner.end();
  }
});
