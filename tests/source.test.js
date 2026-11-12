import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import {
  createDigestReader,
  normalizePublishedDigest,
  normalizeNewsletter,
} from "../src/source.js";

const newsletter = JSON.parse(await readFile(new URL("./fixtures/newsletter-issue-v1.json", import.meta.url), "utf8"));
const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/published-digest-v4.json", import.meta.url),
    "utf8",
  ),
);

test("owned digest pool handles idle connection errors without exposing diagnostics", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  const pool = new EventEmitter();
  let closed = false;
  pool.query = async () => ({ rows: [] });
  pool.end = async () => {
    closed = true;
  };
  const reader = createDigestReader(
    { topicId: "ai", digestDatabaseUrl: "postgresql://unused" },
    { createPool: () => pool },
  );
  await reader.range({ fromDate: "2026-10-21", toDate: "2026-10-23" });
  assert.doesNotThrow(() =>
    pool.emit("error", new Error("credential-must-stay-private")),
  );
  assert.deepEqual(warnings, ["newsletter_digest_connection_lost"]);
  await reader.close();
  assert.equal(closed, true);
});

test("normalizes a real v4 publication without losing source links or editorial body", () => {
  const issue = normalizePublishedDigest(fixture, {
    topicId: fixture.topic.id,
    digestId: fixture.digestId,
  });
  assert.equal(issue.digestId, fixture.digestId);
  assert.equal(issue.topicId, fixture.topic.id);
  assert.deepEqual(issue.items[0].body, fixture.items[0].body);
  assert.deepEqual(issue.items[0].sources, fixture.items[0].sources);
});

test("normalizes historical v3 events into paragraphs and keeps attribution", async () => {
  const { publishedDigestV3 } = await import(
    "./fixtures/published-digest-v3.js"
  );
  const issue = normalizePublishedDigest(publishedDigestV3, {
    topicId: publishedDigestV3.topic.id,
  });
  const first = issue.items[0];
  assert.ok(
    first.body.some((b) =>
      b.spans?.some((s) =>
        s.text.includes(publishedDigestV3.sections.main[0].summary),
      ),
    ),
  );
  assert.deepEqual(first.sources, publishedDigestV3.sections.main[0].sources);
});

test("rejects mismatched topic, relational ID and unsafe publication links", () => {
  assert.throws(() => normalizePublishedDigest(fixture, { topicId: "other" }));
  assert.throws(() => normalizePublishedDigest(fixture, { digestId: "wrong" }));
  const unsafe = structuredClone(fixture);
  unsafe.items[0].sources[0].url = "javascript:alert(1)";
  assert.throws(() => normalizePublishedDigest(unsafe));
  const privateUrl = structuredClone(fixture);
  privateUrl.items[0].sources[0].url = "http://127.0.0.1/admin";
  assert.throws(() => normalizePublishedDigest(privateUrl));
});

test("reader always filters publication queries by configured topic and validates returned rows", async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return {
        rows: [
          {
            issue_id: newsletter.issueId,
            from_date: newsletter.period.fromDate,
            to_date: newsletter.period.toDate,
            document: newsletter,
          },
        ],
      };
    },
  };
  const reader = createDigestReader(
    { topicId: fixture.topic.id, digestDatabaseUrl: "postgresql://unused" },
    { pool },
  );
  await reader.range({ fromDate: newsletter.period.fromDate, toDate: newsletter.period.toDate });
  assert.equal(calls.length, 1);
  for (const c of calls) {
    assert.match(c.sql, /topic_id\s*=\s*\$1/);
    assert.equal(c.values[0], fixture.topic.id);
  }
  assert.deepEqual(calls[0].values.slice(1), [newsletter.period.fromDate, newsletter.period.toDate]);
});

test("reader rejects invalid date windows before querying", async () => {
  let calls = 0;
  const reader = createDigestReader(
    { topicId: "ai", digestDatabaseUrl: "postgresql://unused" },
    {
      pool: {
        query: async () => {
          calls++;
          return { rows: [] };
        },
      },
    },
  );
  await assert.rejects(
    reader.range({ fromDate: "2026-02-30", toDate: "2026-03-01" }),
  );
  await assert.rejects(
    reader.range({ fromDate: "2026-10-24", toDate: "2026-10-21" }),
  );
  assert.equal(calls, 0);
});

test("newsletter identity, eight-card limit, sources and media are validated", () => {
  const valid = normalizeNewsletter(newsletter);
  assert.deepEqual(valid.cards, newsletter.cards);
  assert.throws(() => normalizeNewsletter(newsletter, { fromDate: "2026-01-01" }));
  assert.throws(() => normalizeNewsletter(newsletter, { issueId: "wrong" }));
  const bad = structuredClone(newsletter);
  bad.cards[0].sources[0].url = "https://t.me/channel/1";
  assert.throws(() => normalizeNewsletter(bad));
  bad.cards[0].sources = newsletter.cards[0].sources;
  bad.cards[0].image.url = "https://cdn-telegram.org/image.jpg";
  assert.throws(() => normalizeNewsletter(bad));
  assert.throws(() => normalizeNewsletter({ ...newsletter, cards: Array(9).fill(newsletter.cards[0]) }));
});
