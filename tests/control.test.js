import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, scryptSync } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createControlServer } from "../src/control/server.js";
import { readControlConfig } from "../src/control/config.js";
import { selectableRelease, upcomingDate } from "../src/control/dates.js";
import { operationAllowed, summary } from "../src/control/state.js";

const now = new Date("2026-11-15T13:00:00+03:00");
const issue = JSON.parse(
  readFileSync(
    new URL("./fixtures/newsletter-issue-v1.json", import.meta.url),
    "utf8",
  ),
);
function state() {
  return {
    prep: { issue, heartbeat: { seen_at: now } },
    sender: { heartbeat: { seen_at: now }, campaign: null },
  };
}
test("Moscow schedule selects upcoming release and only known three-day windows", () => {
  assert.equal(
    upcomingDate("2026-11-12", new Date("2026-11-23T20:50Z")),
    "2026-11-24",
  );
  assert.equal(selectableRelease("2026-11-12", "2026-11-18", now), null);
  assert.equal(selectableRelease("2026-11-12", "2026-11-14", now), null);
  assert.equal(
    selectableRelease("2026-11-12", "2026-11-12", now).fromDate,
    "2026-11-09",
  );
});
test("uncertainty, stale workers, future periods and zero delivered are distinct", () => {
  const data = state();
  assert.equal(operationAllowed("send", data, "2026-11-18", now), false);
  data.sender.campaign = { state: "uncertain", message_id: 52 };
  assert.equal(operationAllowed("send", data, "2026-11-12", now), false);
  assert.equal(operationAllowed("check", data, "2026-11-12", now), true);
  data.sender.campaign = {
    state: "failed",
    attempt: 1,
    failure_code: "unisender_rejected",
  };
  assert.equal(operationAllowed("send", data, "2026-11-12", now), true);
  data.sender.heartbeat.seen_at = new Date(+now - 180000);
  assert.equal(operationAllowed("send", data, "2026-11-12", now), false);
  data.sender.campaign = {
    state: "accepted",
    campaign_id: 123,
    delivered_count: 0,
  };
  assert.equal(summary(data, "2026-11-12", now).stats[0], "Доставлено · 0");
  assert.equal(
    summary({ prep: null, sender: null }, "2026-11-12", now).sending[0],
    "Нет связи с журналом",
  );
});
test("retry requires a proven pre-dispatch stop or a declined campaign without any sends", () => {
  const data = state();
  const canSend = (campaign) => {
    data.sender.campaign = campaign;
    return operationAllowed("send", data, "2026-11-12", now);
  };
  const declined = {
    state: "failed",
    campaign_id: 81,
    provider_status: "declined",
    sent_count: 0,
    delivered_count: 0,
    has_observed_sends: false,
  };
  assert.equal(canSend(declined), true);
  assert.equal(
    summary(data, "2026-11-12", now).sending[0],
    "Отклонено модератором",
  );
  for (const change of [
    { sent_count: null },
    { delivered_count: null },
    { sent_count: 2 },
    { has_observed_sends: true },
    { provider_status: "canceled" },
    { provider_status: "stopped" },
  ])
    assert.equal(canSend({ ...declined, ...change }), false);
  for (const failure_code of [
    "window_closed",
    "command_inactive_before_dispatch",
  ]) {
    assert.equal(canSend({ state: "failed", failure_code }), true);
  }
  assert.equal(
    canSend({ state: "uncertain", failure_code: "unisender_timeout" }),
    false,
  );
});
test("public panel requires HTTPS and explicit audience; local and production use distinct cookies", () => {
  const env = {
    CONTROL_ORIGIN: "http://127.0.0.1:8080",
    CONTROL_PASSWORD_HASH: "scrypt:" + "a".repeat(32) + ":" + "b".repeat(128),
    CONTROL_USER: "owner",
    DIGEST_TOPIC_ID: "ai",
    CONTROL_MODE: "test",
    UNISENDER_FIRST_SEND_DATE: "2026-11-12",
    UNISENDER_LIST_ID: "89",
    DIGEST_DATABASE_URL: "postgres://localhost/one",
    NEWSLETTER_DATABASE_URL: "postgres://localhost/two",
  };
  assert.equal(readControlConfig(env).secure, false);
  assert.throws(() =>
    readControlConfig({ ...env, CONTROL_ORIGIN: "http://example.org" }),
  );
  assert.throws(() => readControlConfig({ ...env, CONTROL_MODE: "" }));
});

function hidden(markup) {
  return new URLSearchParams(
    [
      ...markup.matchAll(
        /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
      ),
    ].map((m) => [m[1], m[2]]),
  );
}
test("owner signs in, reviews a missed edition, confirms and queues exactly one send", async (t) => {
  const salt = randomBytes(16).toString("hex");
  const cfg = {
    secure: false,
    origin: "http://127.0.0.1",
    username: "owner",
    salt,
    hash: scryptSync("local-test-password", salt, 64),
    first: "2026-11-12",
    listId: 89,
    mode: "public",
    topic: "ai",
  };
  const data = state(),
    commands = [];
  const store = {
    read: async () => data,
    issue: async () => issue,
    enqueue: async (cmd) => {
      commands.push(cmd);
      data.sender.request = {
        state: "queued",
        action: cmd.action,
        updated_at: now,
      };
    },
  };
  const server = createControlServer({ cfg, store, clock: () => now });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  cfg.origin = `http://127.0.0.1:${server.address().port}`;
  const get = (url, headers = {}) =>
    fetch(cfg.origin + url, { headers, redirect: "manual" });
  const post = (path, params, cookie = "", origin = cfg.origin) =>
    fetch(cfg.origin + path, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: new URLSearchParams(params),
      redirect: "manual",
    });
  assert.equal((await get("/")).headers.get("location"), "/login");
  assert.equal((await get("/preview?date=2026-11-12")).status, 303);
  const signed = await post("/login", {
    user: "owner",
    password: "local-test-password",
  });
  assert.equal(signed.status, 303);
  assert.equal(signed.headers.get("referrer-policy"), "same-origin");
  const cookie = signed.headers.get("set-cookie").split(";")[0];
  const markup = await (
    await get("/?date=2026-11-12", { Cookie: cookie })
  ).text();
  assert.match(markup, /Выпуск готов/);
  const preview = await get("/preview?date=2026-11-12", { Cookie: cookie });
  assert.match(preview.headers.get("content-security-policy"), /sandbox/);
  assert.match(await preview.text(), /Эксперимент с работой без сети/);
  const sendForm = markup.match(
    /<form method="post" action="\/confirm">[\s\S]*?<\/form>/,
  )[0];
  const selected = hidden(sendForm);
  assert.equal(selected.get("action"), "send");
  assert.equal((await post("/action", selected, cookie)).status, 409);
  assert.equal(
    (await post("/confirm", selected, cookie, "https://unrelated.example"))
      .status,
    403,
  );
  const confirmed = await post("/confirm", selected, cookie);
  assert.equal(confirmed.status, 200);
  const text = await confirmed.text();
  assert.match(text, /списка № 89/);
  const intent = hidden(
    text.match(/<form action="\/action" method="post">[\s\S]*?<\/form>/)[0],
  );
  assert.ok(intent.get("signature"));
  const bad = new URLSearchParams(intent);
  bad.set("csrf", "");
  assert.equal((await post("/action", bad, cookie)).status, 403);
  assert.equal((await post("/action", intent, cookie)).status, 303);
  assert.equal((await post("/action", intent, cookie)).status, 409);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].sendDate, "2026-11-12");
  const logout = await post("/logout", { csrf: intent.get("csrf") }, cookie);
  assert.equal(logout.status, 303);
  assert.equal((await get("/", { Cookie: cookie })).status, 303);
});
