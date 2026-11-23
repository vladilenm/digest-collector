import { randomUUID } from "node:crypto";
import { escape } from "../html.js";
import { recentDates, releaseDate, upcomingDate } from "./dates.js";
import { online, operationAllowed, reason, summary } from "./state.js";

const e = (value) => escape(String(value ?? ""));
const display = (date, options) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    ...options,
  }).format(new Date(date));
const stamp = (date) =>
  date
    ? display(date, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }) + " МСК"
    : "";
const day = (date) => display(date, { day: "numeric", month: "long" });
function range(period) {
  if (period.fromDate.slice(0, 7) === period.toDate.slice(0, 7))
    return `${Number(period.fromDate.slice(-2))}–${day(period.toDate)}`;
  return `${day(period.fromDate)} — ${day(period.toDate)}`;
}
function token(name, value) {
  return `<input type="hidden" name="${name}" value="${e(value)}">`;
}
const mark =
  '<span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>';
export function page(title, body, refresh = false) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="30">' : ""}<title>${e(title)} · Пульт рассылки</title><link rel="stylesheet" href="/panel.css"></head><body>${body}</body></html>`;
}
function header(csrf) {
  return `<header class="mast"><div class="brand">${mark}<span>Пульт рассылки</span></div>
  ${csrf ? `<form method="post" action="/logout">${token("csrf", csrf)}<button class="text-button">Выйти</button></form>` : ""}</header>`;
}
export function login(error = "") {
  return page(
    "Вход",
    `${header()}<main class="entry"><section class="entry-card"><div class="kicker">Клуб «Незаменимые»</div>
  <h1>Вход в пульт</h1><p>Управление выпусками email-дайджеста.</p>${error ? `<p class="alert" role="alert">${e(error)}</p>` : ""}
  <form method="post" action="/login"><label>Логин<input name="user" autocomplete="username" required autofocus></label>
  <label>Пароль<input type="password" name="password" autocomplete="current-password" required></label>
  <button class="primary">Войти</button></form></section></main>`,
  );
}
export function notice(title, body, href = "/") {
  return page(
    title,
    `${header()}<main class="entry"><section class="entry-card"><h1>${e(title)}</h1><p>${e(body)}</p>
  <a class="button" href="${e(href)}">Вернуться</a></section></main>`,
  );
}
const labels = {
  prepare: "Повторить подготовку",
  check: "Сверить с Unisender",
  send: "Отправить подписчикам",
};
function actionLabel(action, config, retry, hasError = true) {
  if (action === "prepare" && !hasError) return "Подготовить выпуск";
  if (action === "send" && config.mode === "test")
    return "Отправить тестовое письмо";
  return action === "send" && retry ? "Повторить отправку" : labels[action];
}
function actionForm(action, cfg, period, data, csrf) {
  return `<form method="post" action="/${action === "check" ? "action" : "confirm"}">
    ${token("csrf", csrf)}${token("id", randomUUID())}${token("date", period.sendDate)}${token("action", action)}
    ${token("attempt", data.sender?.campaign?.attempt || 0)}${token("issue", data.prep?.issue?.issueId || "")}
    ${token("audience", cfg.mode + ":" + cfg.listId)}
    <button class="${action === "send" ? "primary" : "button"}">${e(actionLabel(action, cfg, data.sender?.campaign?.state === "failed", data.prep?.preparation?.state === "failed"))}</button></form>`;
}
export function confirmation({ csrf, cfg, period, data, action, fields }) {
  const audience =
    cfg.mode === "public"
      ? `подписчикам списка № ${cfg.listId}`
      : `на тестовый адрес (список № ${cfg.listId})`;
  const descriptions = {
    send: `Выпуск за ${range(period)} будет отправлен ${audience}. Плановая дата этого выпуска — ${day(period.sendDate)}.`,
    prepare: `Topic Digest подготовит выпуск за ${range(period)}. Работающий по расписанию отправщик сможет отправить готовое письмо, если сегодня день этого выпуска.`,
    check: `Отправщик запросит у Unisender сведения о кампании за ${range(period)}.`,
  };
  const label = actionLabel(
    action,
    cfg,
    data.sender?.campaign?.state === "failed",
    data.prep?.preparation?.state === "failed",
  );
  return page(
    label,
    `${header(csrf)}<main class="entry"><section class="entry-card"><div class="kicker">Подтверждение действия</div><h1>${e(label)}</h1>
    <p>${e(descriptions[action])}</p><form action="/action" method="post">
    ${["csrf", "id", "action", "date", "attempt", "issue", "audience", "until", "signature"].map((name) => token(name, fields.get(name))).join("")}
    <div class="buttons"><button class="primary">${action === "send" ? "Подтвердить отправку" : "Подтвердить"}</button>
    <a class="button" href="/?date=${period.sendDate}">Отмена</a></div></form></section></main>`,
  );
}
function reportLink(raw) {
  try {
    const url = new URL(raw);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "unisender.com" ||
        url.hostname.endsWith(".unisender.com"))
    )
      return url.href;
  } catch {
    /* An older campaign might only have an ID. */
  }
  return null;
}
function stage(label, pair, detail, action = "") {
  return `<section class="stage"><div class="stage-caption"><span class="dot ${pair[1]}"></span>${e(label)}</div>
    <h3>${e(pair[0])}</h3>${detail ? `<p>${e(detail)}</p>` : ""}${action}</section>`;
}
function service(name, id, side, now) {
  const ok = side && online(side.heartbeat, now);
  const last = side?.heartbeat?.seen_at;
  return `<div class="service"><div><strong>${name}</strong><small>${side ? (ok ? "На связи" : last ? "Давно не выходил на связь" : "Нет отметок связи") : "База недоступна"}${last ? " · " + e(stamp(last)) : ""}</small></div>
  <a href="https://timeweb.cloud/my/apps/${id}/dashboard" target="_blank" rel="noreferrer">Timeweb ↗</a></div>`;
}
const providerNames = {
  scheduled: "В очереди",
  waits_schedule: "Ожидает запуска",
  waits_censor: "На модерации",
  in_progress: "Рассылается",
  completed: "Рассылка завершена",
  declined: "Отклонено модератором",
  stopped: "Остановлена",
  canceled: "Отменена",
  analysed: "Обработана",
  censor_hold: "Модерация приостановлена",
};
export function dashboard({ csrf, cfg, period, data, now }) {
  const { prep, sender } = data,
    issue = prep?.issue,
    campaign = sender?.campaign,
    date = period.sendDate;
  const s = summary(data, date, now);
  const op = (action) =>
    operationAllowed(action, data, date, now)
      ? actionForm(action, cfg, period, data, csrf)
      : "";
  const report = reportLink(campaign?.report_url);
  const prepDetail = [
    issue
      ? `Карточек · ${issue.cards.length}`
      : reason(prep?.preparation?.error_code),
    prep?.preparation?.started_at &&
      "Начало · " + stamp(prep.preparation.started_at),
    prep?.preparation?.state === "failed" &&
      "Ошибка · " + stamp(prep.preparation.updated_at),
    issue?.preparedAt
      ? "Готово · " + stamp(issue.preparedAt)
      : prep?.lastSuccess &&
        "Предыдущий успешный выпуск · " + stamp(prep.lastSuccess),
  ]
    .filter(Boolean)
    .join(". ");
  const sentDetail =
    reason(campaign?.rejection_code || campaign?.failure_code) ||
    (campaign?.campaign_id
      ? `Кампания № ${campaign.campaign_id} · ${providerNames[campaign.provider_status] || "Статус уточняется"}`
      : "");
  const pending = [
    prep?.request && {
      ...prep.request,
      title: "Подготовка",
      code: prep.request.error_code,
    },
    sender?.request && {
      ...sender.request,
      title: sender.request.action === "check" ? "Сверка" : "Отправка",
      code: sender.request.result_code,
    },
  ].filter(Boolean);
  const commandStates = {
    queued: "В очереди",
    running: "Выполняется",
    done: "Завершено",
    failed: "Ошибка",
  };
  return page(
    "Выпуски",
    `${header(csrf)}<main class="workspace">
  <aside class="archive"><h2>Выпуски</h2><nav aria-label="Выпуски по датам">${recentDates(
    cfg.first,
    now,
    date,
  )
    .map(
      (day) =>
        `<a href="/?date=${day}" ${day === date ? 'aria-current="page"' : ""}><strong>${e(range(releaseDate(cfg.first, day)))}</strong><small>${day.split("-").reverse().join(".")} · отправка</small></a>`,
    )
    .join("")}</nav>
  <form action="/" method="get" class="picker"><label for="date">Другой день отправки</label><input id="date" type="date" name="date" value="${date}" min="${e(cfg.first)}" max="${upcomingDate(cfg.first, now)}" step="3" required><button class="text-button">Открыть выпуск →</button></form></aside>
  <div class="content"><div class="issue-heading"><div><div class="kicker">Email-дайджест</div><h1>${e(range(period))}</h1>
  <p>Плановая отправка · <b>${e(day(date))}, 10:00 МСК</b></p></div>${issue?.cards.length ? `<a class="button" href="/preview?date=${date}" target="_blank" rel="noreferrer">Посмотреть письмо ↗</a>` : ""}</div>
  <div class="section-title"><h2>Состояние выпуска</h2><small>Обновлено в ${e(display(now, { hour: "2-digit", minute: "2-digit" }))} МСК</small></div>
  <div class="stages">${stage("Подготовка", s.preparation, prepDetail, op("prepare"))}
  ${stage("Отправка", s.sending, sentDetail, op("send") + op("check"))}
  ${stage(
    "Доставка",
    s.stats,
    campaign?.stats_checked_at
      ? "Последняя сверка · " + stamp(campaign.stats_checked_at)
      : "",
    campaign?.campaign_id
      ? `<a class="inline-link" target="_blank" rel="noreferrer" href="${e(report || "https://app.unisender.com/ru/v5/spa/campaigns")}">${report ? "Отчёт кампании" : "История в Unisender"} ↗</a>`
      : "",
  )}</div>
  ${pending.length ? `<section class="history"><h2>Последние действия</h2>${pending.map((req) => `<p><b>${req.title}</b> · ${e(commandStates[req.state] || req.state)} · ${e(stamp(req.updated_at))} ${e(reason(req.code))}</p>`).join("")}</section>` : ""}
  <section class="services"><h2>Рабочие сервисы</h2>${service("Topic Digest", 246379, prep, now)}${service("Club Digest Sender", 287351, sender, now)}</section>
  <footer>${cfg.mode === "test" ? "Тестовый режим" : "Подписчики"} · список № ${cfg.listId}</footer></div></main>`,
    true,
  );
}
