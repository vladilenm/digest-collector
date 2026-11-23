import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createCommonDigestPublisher } from "../src/service.js";
import { UnisenderError } from "../src/client.js";
import { createSenderControlRepository, reconcileCampaign } from "../src/sender-control.js";
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
    await owner.query("DELETE FROM newsletter.unisender_campaigns WHERE topic_id=$1 AND list_id=$2 AND send_date=$3", [key.topicId, key.listId, key.sendDate]);
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
    const row = (await session.query("SELECT state, issue_ids, content_hash, message_id FROM newsletter.unisender_campaigns WHERE topic_id=$1 AND list_id=$2 AND send_date=$3 AND mode='test'", [key.topicId,key.listId,key.sendDate])).rows[0];
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

test(
  "public control requests expire across outages, tie retries to one rejection, and reconcile crash records",
  { skip: !url },
  async () => {
    assert.match(new URL(url).pathname, /_test$/);
    const owner = new pg.Pool({ connectionString: url });
    const runtimeRole = "sender_control_fixture_runtime";
    const panelRole = "sender_control_fixture_panel";
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/newsletter-issue-v1.json", import.meta.url)),
    );
    const topicId = "sender-fixture";
    fixture.topic.id = topicId;
    const sendDate = "2026-11-12";
    const config = {
      topicId,
      listId: 9911,
      mode: "public",
      enabled: true,
      controlEnabled: true,
      firstSendDate: sendDate,
    };
    const journalKey = {
      ...config,
      sendDate,
      fromDate: fixture.period.fromDate,
      toDate: fixture.period.toDate,
    };
    let runtime, panel;
    try {
      runtime = await owner.connect();
      panel = await owner.connect();
      const loopback = ["localhost", "127.0.0.1", "[::1]", "postgres"].includes(new URL(url).hostname);
      execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/migrate.mjs", import.meta.url))], {
        env: {
          ...process.env,
          NEWSLETTER_MIGRATION_URL: url,
          NEWSLETTER_DATABASE_NETWORK: process.env.NEWSLETTER_DATABASE_NETWORK || (loopback ? "local" : "remote"),
          NEWSLETTER_DATABASE_SSL: process.env.NEWSLETTER_DATABASE_SSL || (loopback ? "off" : "require"),
        },
      });
      for (const [role, file, variable] of [
        [runtimeRole, "control-sender-grants", "runtime_role"],
        [panelRole, "control-panel-grants", "panel_role"],
      ]) {
        if (!(await owner.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount)
          await owner.query(`CREATE ROLE ${role}`);
        const grants = await readFile(new URL(`../database/${file}.sql`, import.meta.url), "utf8");
        await owner.query(grants.replaceAll(`:"${variable}"`, role));
      }
      for (const table of ["sender_health", "operator_requests", "unisender_campaigns"])
        await owner.query(`DELETE FROM newsletter.${table} WHERE topic_id=$1`, [topicId]);
      await runtime.query(`SET ROLE ${runtimeRole}`);
      await panel.query(`SET ROLE ${panelRole}`);
      const control = createSenderControlRepository(runtime, config);
      const second = createSenderControlRepository(owner, config);
      const journal = createUnisenderCampaignRepository(runtime, config);
      const enqueue = async (action, retryAttempt = 0) => {
        const id = randomUUID();
        await panel.query(
          `INSERT INTO newsletter.operator_requests (id,topic_id,list_id,mode,send_date,action,retry_attempt)
        VALUES ($1,$2,$3,'public',$4,$5,$6)`,
          [id, topicId, config.listId, sendDate, action, retryAttempt],
        );
        return id;
      };
      const result = async (id) =>
        (await panel.query("SELECT state,result_code FROM newsletter.operator_requests WHERE id=$1", [id]))
          .rows[0];
      const changeClock = (table, column, seconds) =>
        owner.query(
          `UPDATE newsletter.${table} SET ${column}=now() - make_interval(secs => $2) WHERE topic_id=$1`,
          [topicId, seconds],
        );
      await assert.rejects(panel.query("UPDATE newsletter.unisender_campaigns SET state='accepted'"), {
        code: "42501",
      });
      await assert.rejects(
        panel.query("INSERT INTO newsletter.operator_requests (id,state) VALUES ($1,'done')", [randomUUID()]),
        { code: "42501" },
      );
      await control.pulse();
      const abandoned = await enqueue("send");
      await assert.rejects(enqueue("send"), { code: "23505" });
      await changeClock("sender_health", "seen_at", 100);
      assert.equal(await control.take(), undefined);
      await control.pulse();
      assert.deepEqual(await result(abandoned), { state: "failed", result_code: "worker_stale" });
      const interrupted = await enqueue("send");
      assert.equal((await control.take()).id, interrupted);
      assert.equal(await control.active(interrupted), true);
      await changeClock("operator_requests", "updated_at", 95);
      await control.pulse(interrupted);
      assert.equal(await control.active(interrupted), false);
      assert.deepEqual(await result(interrupted), { state: "failed", result_code: "worker_interrupted" });

      const request = await enqueue("send");
      const claims = await Promise.all([control.take(), second.take()]);
      assert.deepEqual(
        claims.filter(Boolean).map((x) => x.id),
        [request],
      );
      let sends = 0;
      let reject = true;
      const client = {
        createMessage: async () => 12,
        startCampaign: async () => {
          sends++;
          if (reject)
            throw new UnisenderError("unisender_rejected", {
              ambiguous: false,
              rejectionCode: "not_enough_money",
            });
          throw new UnisenderError("unisender_timeout");
        },
      };
      const makePublisher = (repository) =>
        createCommonDigestPublisher({
          config,
          repository,
          digestReader: { range: async () => [fixture] },
          client,
          now: () => new Date("2026-11-12T07:00:00Z"),
        });
      const worker = makePublisher(journal);
      const auto = makePublisher(createUnisenderCampaignRepository(owner, config));
      const first = await Promise.all([
        worker.tick({ sendDate, requestActive: () => control.active(request) }),
        auto.tick(),
      ]);
      assert.deepEqual(first.map((x) => x.status).sort(), ["already_claimed", "failed"]);
      assert.equal(sends, 1);
      await control.finish(request, first[0].status);
      const reason = (
        await panel.query(
          "SELECT failure_code,rejection_code FROM newsletter.unisender_campaigns WHERE topic_id=$1",
          [topicId],
        )
      ).rows[0];
      assert.deepEqual(reason, { failure_code: "unisender_rejected", rejection_code: "not_enough_money" });
      const retryOptions = { sendDate, retryAttempt: 1 };
      const retry = await Promise.all([worker.tick(retryOptions), auto.tick(retryOptions)]);
      assert.deepEqual(retry.map((x) => x.status).sort(), ["already_claimed", "failed"]);
      assert.equal(sends, 2);
      assert.equal((await worker.tick(retryOptions)).status, "already_claimed");
      reject = false;
      assert.equal((await worker.tick({ sendDate, retryAttempt: 2 })).status, "uncertain");
      assert.equal(await journal.claimRejected(journalKey, 3), false);
      assert.equal(sends, 3);
      const ambiguous = await control.campaign(sendDate);
      assert.equal(ambiguous.attempt, 3);
      assert.equal(ambiguous.message_id, 12);
      assert.equal(
        await reconcileCampaign({
          row: ambiguous,
          control,
          listId: config.listId,
          client: {
            findCampaign: async () => ({
              code: "matched",
              campaignId: 44,
              providerStatus: "in_progress",
              reportUrl: "https://app.unisender.com/report",
            }),
            campaignDelivered: async () => 0,
          },
        }),
        "checked",
      );
      let stats = (
        await panel.query(
          "SELECT state,campaign_id,delivered_count,stats_checked_at FROM newsletter.unisender_campaigns WHERE topic_id=$1",
          [topicId],
        )
      ).rows[0];
      assert.equal(stats.state, "accepted");
      assert.equal(stats.campaign_id, 44);
      assert.equal(stats.delivered_count, 0);
      assert.ok(stats.stats_checked_at);
      assert.equal(await control.nextReport(), undefined);
      await changeClock("unisender_campaigns", "stats_attempted_at", 16 * 60);
      const reports = await Promise.all([control.nextReport(), second.nextReport()]);
      assert.equal(reports.filter(Boolean).length, 1);
      const older = reports.find(Boolean);
      const accepted = await control.campaign(sendDate);
      assert.equal(await control.recordStatus(older, 44, "in_progress", null), false);
      assert.equal(await control.recordDelivered(older, 44, 9), false);
      assert.equal(
        await reconcileCampaign({
          row: accepted,
          control,
          listId: config.listId,
          client: {
            campaignStatus: async () => "declined",
            campaignDelivered: async () => null,
          },
        }),
        "report_pending",
      );
      assert.equal(await journal.claimRejected(journalKey, 3), false);
      stats = (
        await panel.query(
          "SELECT state,provider_status,campaign_id,delivered_count FROM newsletter.unisender_campaigns WHERE topic_id=$1",
          [topicId],
        )
      ).rows[0];
      assert.deepEqual(stats, {
        state: "failed",
        provider_status: "declined",
        campaign_id: 44,
        delivered_count: 0,
      });
    } finally {
      for (const session of [runtime, panel]) {
        if (session)
          await session
            .query("ROLLBACK")
            .then(() => session.query("RESET ROLE"))
            .finally(() => session.release());
      }
      await owner.end();
    }
  },
);

test(
  "sender-control migration preserves historical campaign IDs and the actual attempt time",
  { skip: !url },
  async () => {
    assert.match(new URL(url).pathname, /_test$/);
    const owner = new pg.Client({ connectionString: url });
    const schema = "sender_control_upgrade_fixture";
    await owner.connect();
    try {
      await owner.query("BEGIN");
      await owner.query(`CREATE SCHEMA ${schema}`);
      const apply = async (file) => {
        const sql = await readFile(new URL(`../database/${file}`, import.meta.url), "utf8");
        await owner.query(sql.replaceAll("newsletter.", `${schema}.`));
      };
      await apply("003-unisender-campaigns.sql");
      await owner.query(
        `INSERT INTO ${schema}.unisender_campaigns
      (topic_id,list_id,send_date,mode,from_date,to_date,state,issue_ids,content_hash,message_id,campaign_id,
       provider_status,created_at) VALUES ('old',88,'2026-11-12','public','2026-11-09','2026-11-11','accepted',
       $1::uuid[], $2, 5, 6, 'scheduled', '2026-11-14 12:30 UTC')`,
        [fields.issueIds, fields.contentHash],
      );
      await apply("004-sender-control.sql");
      const row = (
        await owner.query(`SELECT state,campaign_id,message_id,attempt,attempt_started_at,delivered_count
      FROM ${schema}.unisender_campaigns`)
      ).rows[0];
      assert.deepEqual(row, {
        state: "accepted",
        campaign_id: 6,
        message_id: 5,
        attempt: 1,
        attempt_started_at: new Date("2026-11-14T12:30:00Z"),
        delivered_count: null,
      });
    } finally {
      await owner.query("ROLLBACK");
      await owner.end();
    }
  },
);
