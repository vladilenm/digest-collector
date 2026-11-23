import assert from "node:assert/strict";
import { test } from "node:test";
import { createUnisenderClient } from "../src/client.js";
import { createSenderControl, reconcileCampaign } from "../src/sender-control.js";
import { readUnisenderPublisherConfig } from "../src/config.js";

const config = {
  enabled: true,
  provider: "unisender",
  listId: 88,
  testRecipient: "digest@irreplaceable-ai.ru",
};
const row = {
  state: "uncertain",
  send_date: "2026-11-12",
  attempt_started_at: new Date("2026-11-23T12:24:40.000Z"),
  attempt: 1,
  message_id: 3,
  campaign_id: null,
  report_url: null,
};
const campaign = {
  id: 42,
  message_id: 3,
  list_id: 88,
  status: "completed",
  stats_url: "https://app.unisender.com/ru/v5/bursts/view/42",
};
function checks(reply) {
  const calls = [];
  const writes = [];
  const client = createUnisenderClient(config, {
    fetchImpl: async (url, init) => {
      const method = new URL(url).pathname.split("/").pop();
      const params = Object.fromEntries(init.body);
      calls.push(method);
      return Response.json(await reply(method, params));
    },
  });
  const control = {
    recordStatus: async (...args) => {
      writes.push(["status", ...args]);
      return true;
    },
    recordDelivered: async (...args) => {
      writes.push(["delivered", ...args]);
      return true;
    },
  };
  return {
    run: (record = row) =>
      reconcileCampaign({
        client,
        control,
        row: record,
        listId: 88,
        now: () => new Date("2026-11-24T00:00:00Z"),
      }),
    calls,
    writes,
  };
}

test("control is gated by exact opt-in", () => {
  for (const value of [undefined, "", "1", "TRUE"]) {
    assert.equal(readUnisenderPublisherConfig({ NEWSLETTER_CONTROL_ENABLED: value }).controlEnabled, false);
  }
  assert.equal(readUnisenderPublisherConfig({ NEWSLETTER_CONTROL_ENABLED: "true" }).controlEnabled, true);
});

test("an ambiguous backfill uses paginated UTC start times, exact message/list, and actual zero delivered", async () => {
  const { run, calls, writes } = checks((method, params) => {
    if (method === "getCampaigns") {
      assert.equal(params.from, "2026-11-22 12:24:40");
      assert.equal(params.to, "2026-11-25 00:00:00");
      if (params.offset === "0")
        return {
          result: Array.from({ length: Number(params.limit) }, (_, i) => ({
            ...campaign,
            id: i + 1,
            list_id: 89,
          })),
        };
      assert.equal(params.offset, params.limit);
      return { result: [campaign, { ...campaign, id: 2, message_id: 4 }] };
    }
    assert.equal(params.campaign_id, "42");
    assert.equal(method, "getCampaignCommonStats");
    return { result: { total: 13, sent: 13, delivered: 0 } };
  });
  assert.equal(await run(), "checked");
  assert.deepEqual(calls, ["getCampaigns", "getCampaigns", "getCampaignCommonStats"]);
  assert.deepEqual(writes, [
    ["status", row, 42, "completed", campaign.stats_url],
    ["delivered", row, 42, 0],
  ]);
});

test("a missing or non-unique match remains uncertain; a subject match cannot identify a campaign", async () => {
  for (const [found, expected] of [
    [
      [
        { ...campaign, message_id: 5 },
        { ...campaign, list_id: 7 },
      ],
      "match_missing",
    ],
    [[campaign, { ...campaign, id: 92 }], "match_ambiguous"],
  ]) {
    const check = checks(() => ({ result: found }));
    assert.equal(await check.run(), expected);
    assert.deepEqual(check.calls, ["getCampaigns"]);
    assert.equal(check.writes.length, 0);
  }
  const check = checks(() => assert.fail());
  assert.equal(await check.run({ ...row, message_id: null }), "match_missing");
  assert.equal(check.calls.length, 0);
});

test("a known campaign uses direct read-only status/stats; temporary report failure preserves association", async () => {
  const known = { ...row, campaign_id: 42, report_url: campaign.stats_url };
  for (const [stats, code] of [
    [{ result: { total: 13 } }, "report_pending"],
    [{ error: "private upstream text", code: "retry_later" }, "provider_unavailable"],
  ]) {
    const check = checks((method) =>
      method === "getCampaignStatus" ? { result: { status: "declined" } } : stats,
    );
    assert.equal(await check.run(known), code);
    assert.deepEqual(check.calls, ["getCampaignStatus", "getCampaignCommonStats"]);
    assert.deepEqual(check.writes, [["status", known, 42, "declined", campaign.stats_url]]);
  }
});

test("optional report link is restricted to the provider, provider responses do not inject a public URL", async () => {
  for (const stats_url of [
    "http://unisender.com/x",
    "https://unisender.com.example.org/x",
    "https://secret@app.unisender.com/x",
    "javascript:throw 1",
  ]) {
    const check = checks((method) => ({
      result: method === "getCampaigns" ? [{ ...campaign, stats_url }] : { delivered: 11 },
    }));
    assert.equal(await check.run(), "checked");
    assert.equal(check.writes[0].at(-1), null);
  }
});

test("heartbeat renews a running operator request independently of a stalled provider call", async () => {
  const abort = new AbortController();
  const sleeping = Promise.withResolvers();
  const started = Promise.withResolvers();
  const completed = Promise.withResolvers();
  const pulseAgain = Promise.withResolvers();
  const beats = [];
  const worker = createSenderControl({
    config,
    onError: () => assert.fail("unexpected control failure"),
    control: {
      pulse: async (id) => {
        beats.push(id);
        if (id) pulseAgain.resolve();
      },
      take: async () => ({ id: "manual", send_date: row.send_date, action: "send", retry_attempt: 0 }),
      finish: async (_id, code) => {
        assert.equal(code, "accepted");
        abort.abort();
      },
    },
    publisher: {
      tick: async () => {
        started.resolve();
        return completed.promise;
      },
    },
    wait: (_delay, _value, { signal }) => {
      if (beats.length === 1) return sleeping.promise;
      return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  });
  const task = worker.run(abort.signal);
  await started.promise;
  sleeping.resolve();
  await pulseAgain.promise;
  completed.resolve({ status: "accepted" });
  await task;
  assert.deepEqual(beats, [undefined, "manual"]);
});

test("a partial provider listing cannot establish a unique match", async () => {
  const check = checks((_method, params) => ({
    result: Array.from({ length: Number(params.limit) }, () => campaign),
  }));
  assert.equal(await check.run(), "match_incomplete");
  assert.equal(check.writes.length, 0);
});
