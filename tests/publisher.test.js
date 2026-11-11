import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizePublishedDigest } from "../src/source.js";
import { commonWindow } from "../src/schedule.js";
import { readUnisenderPublisherConfig } from "../src/config.js";
import { createUnisenderClient } from "../src/client.js";
import { renderCommonDigest } from "../src/render.js";
import { createCommonDigestPublisher } from "../src/service.js";

const window = { sendDate: "2027-01-02", fromDate: "2026-12-30", toDate: "2027-01-01" };
const firstDate = "2026-12-30";
const now = () => new Date("2027-01-02T07:00:00Z");
const address = "digest@irreplaceable-ai.ru";
const apiKey = "private-test-api-key";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/published-digest-v4.json", import.meta.url), "utf8"));
fixture.publicationDate = "2027-01-01";
const issue = normalizePublishedDigest(fixture);
const env = {
  UNISENDER_FIRST_SEND_DATE: firstDate,
  UNISENDER_API_KEY: apiKey,
  UNISENDER_LIST_ID: "88",
  UNISENDER_ACCOUNT_READY: "true",
  UNISENDER_CAMPAIGNS_ENABLED: "true",
  NEWSLETTER_TEST_RECIPIENT: address,
  NEWSLETTER_DATABASE_URL: "postgresql://newsletter@127.0.0.1:55449/newsletter_test",
  NEWSLETTER_DATABASE_NETWORK: "local",
  NEWSLETTER_DATABASE_SSL: "off",
  DIGEST_DATABASE_URL: "postgresql://reader@127.0.0.1:55449/newsletter_test",
  DIGEST_DATABASE_NETWORK: "local",
  DIGEST_DATABASE_SSL: "off",
  DIGEST_TOPIC_ID: "ai",
};
const config = readUnisenderPublisherConfig(env);
const json = (result) => Response.json(result);

test("three-day window uses completed Moscow dates across New Year", () => {
  assert.equal(commonWindow(new Date("2027-01-02T06:59:59.999Z"), firstDate), null);
  assert.deepEqual(commonWindow(now(), firstDate), window);
  assert.deepEqual(commonWindow(new Date("2027-01-02T20:59:59.999Z"), firstDate), window);
  assert.equal(commonWindow(new Date("2027-01-02T21:00:00Z"), firstDate), null);
  assert.equal(commonWindow(new Date("2027-01-03T07:00:00Z"), firstDate), null);
});

test("first send date must exist and a future date never sends early", () => {
  assert.equal(commonWindow(now(), "2027-01-05"), null);
  for (const invalid of ["2026-02-29", "2027-1-02", "2027-01-02\n", "", "0000-01-02"])
    assert.throws(() => commonWindow(now(), invalid), /invalid_first_send_date/);
  assert.deepEqual(commonWindow(new Date("2028-03-01T07:00:00Z"), "2028-03-01"), {
    sendDate: "2028-03-01", fromDate: "2028-02-27", toDate: "2028-02-29",
  });
});

test("publisher needs explicit enablement and a test recipient or explicit public delivery", () => {
  assert.equal(readUnisenderPublisherConfig({}).enabled, false);
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "test");
  for (const overrides of [
    { NEWSLETTER_PROVIDER: "notisend" },
    { UNISENDER_API_KEY: "" },
    { UNISENDER_ACCOUNT_READY: "false" },
    { UNISENDER_CAMPAIGNS_ENABLED: "false" },
    { UNISENDER_LIST_ID: "0" },
    { UNISENDER_FIRST_SEND_DATE: "2027-02-29" },
    { NEWSLETTER_TEST_RECIPIENT: "" },
    { NEWSLETTER_TEST_RECIPIENT: "wrong@example.com", UNISENDER_PUBLIC_DELIVERY_ENABLED: "true" },
    { DIGEST_DATABASE_URL: "" },
    { DIGEST_TOPIC_ID: "" },
    { NEWSLETTER_DATABASE_URL: "" },
    { DIGEST_DATABASE_URL: "postgresql://reader@example.com/newsletter_test" },
  ]) {
    assert.equal(readUnisenderPublisherConfig({ ...env, ...overrides }).enabled, false, Object.keys(overrides).join(","));
  }
  const publicConfig = readUnisenderPublisherConfig({
    ...env, NEWSLETTER_TEST_RECIPIENT: "", UNISENDER_PUBLIC_DELIVERY_ENABLED: "true",
  });
  assert.equal(publicConfig.enabled, true);
  assert.equal(publicConfig.mode, "public");
});

test("API key stays in the POST body and test campaign is scoped to the approved address", async () => {
  const calls = [];
  const client = createUnisenderClient(config, { fetchImpl: async (url, options) => {
    calls.push({ url, ...options, params: new URLSearchParams(options.body) });
    return json({ result: calls.length === 1 ? { message_id: 12 } : { campaign_id: 13, status: "waits_censor" } });
  } });
  const messageId = await client.createMessage({ subject: "Subject", html: "<p>Hi</p>", text: "Hi" });
  assert.equal(messageId, 12);
  assert.deepEqual(await client.startCampaign({ messageId }), { campaignId: 13, providerStatus: "waits_censor" });
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://api.unisender.com/ru/api/createEmailMessage?format=json",
    "https://api.unisender.com/ru/api/createCampaign?format=json",
  ]);
  for (const call of calls) {
    assert.equal(call.method, "POST");
    assert.equal(call.redirect, "error");
    assert.equal(call.params.get("api_key"), apiKey);
  }
  assert.deepEqual(Object.fromEntries(calls[0].params), {
    api_key: apiKey, sender_email: address, sender_name: "Владилен Минин · Незаменимые",
    list_id: "88", subject: "Subject", body: "<p>Hi</p>", text_body: "Hi", lang: "ru", wrap_type: "skip",
  });
  assert.deepEqual(Object.fromEntries(calls[1].params), {
    api_key: apiKey, message_id: "12", contacts: address, track_read: "0", track_links: "0", track_ga: "0",
  });
});

test("campaign client refuses a foreign address and omits contacts only with the public flag", async () => {
  const calls = [];
  const fetchImpl = async (_, options) => {
    calls.push(new URLSearchParams(options.body));
    return json({ result: { campaign_id: 13, status: "scheduled" } });
  };
  for (const overrides of [
    { testRecipient: "wrong@example.com", publicDeliveryEnabled: true },
    { testRecipient: "", publicDeliveryEnabled: false },
    { testRecipient: address + ",other@example.com" },
  ]) {
    const client = createUnisenderClient({ ...config, ...overrides }, { fetchImpl });
    await assert.rejects(() => client.startCampaign({ messageId: 12 }), { message: "unisender_delivery_blocked" });
  }
  assert.equal(calls.length, 0);
  const client = createUnisenderClient({ ...config, testRecipient: "", publicDeliveryEnabled: true }, { fetchImpl });
  await client.startCampaign({ messageId: 12 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].has("contacts"), false);
});

test("provider errors are sanitized and uncertain replies are never retried", async () => {
  for (const [fetchResult, message, ambiguous, campaignId] of [
    [() => json({ error: apiKey, code: "invalid_arg" }), "unisender_rejected", false],
    [() => json({ error: apiKey, code: "retry_later" }), "unisender_provider_error", true],
    [() => json({ error: apiKey, code: "new_code", result: { campaign_id: 13 } }), "unisender_provider_error", true, 13],
    [() => json({ error: apiKey, code: "campaign_already_exists" }), "unisender_campaign_exists", true],
    [() => new Response(apiKey, { status: 503 }), "unisender_http_error", true],
    [() => new Response(apiKey), "unisender_invalid_response", true],
    [() => new Response("x".repeat(70_000)), "unisender_invalid_response", true],
    [() => json({ result: { status: "scheduled" } }), "unisender_invalid_response", true],
    [() => json({ result: { campaign_id: 13, status: "unknown" } }), "unisender_invalid_response", true, 13],
    [() => { throw new TypeError(apiKey); }, "unisender_network_error", true],
  ]) {
    let calls = 0;
    const client = createUnisenderClient(config, { fetchImpl: async () => { calls++; return fetchResult(); } });
    await assert.rejects(() => client.startCampaign({ messageId: 12 }), (error) => {
      assert.equal(error.message, message);
      assert.equal(error.ambiguous, ambiguous);
      assert.equal(error.campaignId, campaignId);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("campaign client bounds provider timeouts", async () => {
  const client = createUnisenderClient(config, { timeoutMs: 5, fetchImpl: async (_, { signal }) => {
    // Hold a ref because AbortSignal.timeout() does not keep the process alive.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  } });
  await assert.rejects(() => client.startCampaign({ messageId: 12 }), {
    message: "unisender_timeout", ambiguous: true,
  });
});

test("branded content deduplicates events and keeps source links and the only live substitution", () => {
  const newer = structuredClone(issue);
  newer.items[0].title = "<script>{{UnsubscribeUrl}}</script>";
  newer.items[0].body[0].spans[0].text = "{{Email}}: редакционный текст";
  newer.items[0].sources.push({ label: "{{Name}}", url: "https://example.org/a?x={{Email}}&y=2" });
  newer.items[0].sources.push({ label: "unsafe", url: "https://login:password@example.org/" });
  newer.items[0].sources.push({ label: "unsafe", url: "javascript:alert(1)" });
  const older = { ...issue, digestId: "00000000-0000-4000-8000-000000000001", publicationDate: "2026-12-30", items: [issue.items[0]] };
  const result = renderCommonDigest({ issues: [newer, older], ...window });
  assert.deepEqual(result, renderCommonDigest({ issues: [newer, older], ...window }));
  assert.equal(result.itemCount, 3);
  assert.deepEqual(result.issueIds, [newer.digestId, older.digestId]);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.match(result.subject, /30\.12\.2026.*01\.01\.2027/);
  assert.match(result.html, /role="presentation"/);
  assert.match(result.html, /club\/logo-light\.png/);
  assert.match(result.html, /&lt;script&gt;/);
  assert.match(result.html, /https:\/\/example\.org\/a\?x=%7B%7BEmail%7D%7D&amp;y=2/);
  assert.match(result.text, /https:\/\/example\.org\/a\?x=%7B%7BEmail%7D%7D&y=2/);
  assert.match(result.html, /href="{{UnsubscribeUrl}}"/);
  assert.doesNotMatch(result.html, /<script>/);
  for (const body of [result.html, result.text]) {
    assert.equal(body.match(/{{.*?}}/g)?.length, 1);
    assert.doesNotMatch(body, /login:password|javascript:|Настроить частоту/);
  }
});

function setup({ configuration = config, read, transition, provider, clock = now, claim } = {}) {
  const calls = [];
  const service = createCommonDigestPublisher({
    config: configuration, now: clock,
    digestReader: { range: async (range) => {
      calls.push(["read", range]);
      return read ? read() : [issue];
    } },
    repository: {
      claim: async (key) => {
        calls.push(["claim", key]);
        return claim ? claim() : true;
      },
      transition: async (key, state, next, fields) => {
        calls.push([next, state, fields]);
        await transition?.(next);
      },
    },
    client: {
      createMessage: async () => { calls.push(["createMessage"]); return 12; },
      startCampaign: async () => {
        calls.push(["startCampaign"]);
        return provider ? provider() : { campaignId: 13, providerStatus: "scheduled" };
      },
    },
  });
  return { service, calls };
}

test("disabled publisher is a no-op; dry run uses only the source even without API or journal", async () => {
  const configuration = readUnisenderPublisherConfig({
    ...env, UNISENDER_API_KEY: "", UNISENDER_ACCOUNT_READY: "false", NEWSLETTER_DATABASE_URL: "",
  });
  const { service, calls } = setup({ configuration });
  assert.equal((await service.tick()).status, "disabled");
  assert.deepEqual(calls, []);
  assert.deepEqual(await service.tick({ dryRun: true }), { status: "preview", dryRun: true, issueCount: 1, itemCount: 3 });
  assert.deepEqual(calls, [["read", { fromDate: window.fromDate, toDate: window.toDate }]]);
});

test("an empty period is journaled as skipped and invalid source data cannot look empty", async () => {
  for (const [read, expected] of [
    [() => [], "skipped"],
    [() => [{ ...issue, topicId: "other" }], "failed"],
    [() => [{ ...issue, publicationDate: window.sendDate }], "failed"],
    [() => { throw new Error(apiKey); }, "failed"],
  ]) {
    const { service, calls } = setup({ read });
    const result = await service.tick();
    assert.equal(result.status, expected);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
    assert.deepEqual(calls.map(([name]) => name), ["claim", "read", expected]);
  }
});

test("durable message ID and sending state precede the first campaign request", async () => {
  const { service, calls } = setup();
  assert.equal((await service.tick()).status, "accepted");
  assert.deepEqual(calls.map(([name]) => name), [
    "claim", "read", "preparing", "createMessage", "draft", "sending", "startCampaign", "accepted",
  ]);
  assert.deepEqual(calls[0][1], { ...window, topicId: "ai", listId: 88, mode: "test" });
  assert.equal(calls[4][2].messageId, 12);
  assert.equal(calls.at(-1)[2].campaignId, 13);
});

test("claim loss and persistence errors before sending never launch a campaign", async () => {
  const duplicate = setup({ claim: () => false });
  assert.equal((await duplicate.service.tick()).status, "already_claimed");
  assert.deepEqual(duplicate.calls.map(([name]) => name), ["claim"]);
  for (const failState of ["preparing", "draft", "sending"]) {
    const { service, calls } = setup({ transition: (state) => {
      if (state === failState) throw new Error(apiKey);
    } });
    assert.equal((await service.tick()).status, "failed");
    assert.equal(calls.some(([name]) => name === "startCampaign"), false);
    if (failState === "preparing") assert.equal(calls.some(([name]) => name === "createMessage"), false);
  }
});

test("interruption after starting is uncertain; failed acceptance persistence retains remote IDs if possible", async () => {
  const interrupted = setup({ provider: () => { throw new Error(apiKey); } });
  assert.equal((await interrupted.service.tick()).status, "uncertain");
  assert.equal(interrupted.calls.at(-1)[0], "uncertain");
  const persistence = setup({ transition: (state) => {
    if (state === "accepted") throw new Error(apiKey);
  } });
  assert.equal((await persistence.service.tick()).status, "uncertain");
  assert.deepEqual(persistence.calls.at(-1), ["uncertain", "sending", {
    campaignId: 13, providerStatus: "scheduled", failureCode: "journal_write_failed",
  }]);
});

test("a tick that crosses midnight before sending cannot replay yesterday's window", async () => {
  let instant = now();
  const { service, calls } = setup({
    clock: () => instant,
    transition: (state) => { if (state === "sending") instant = new Date("2027-01-02T21:00:00Z"); },
  });
  assert.equal((await service.tick()).status, "failed");
  assert.equal(calls.some(([name]) => name === "startCampaign"), false);
});
