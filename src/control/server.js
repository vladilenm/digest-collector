import { createServer } from "node:http";
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { renderCommonDigest } from "../render.js";
import { selectableRelease, upcomingDate } from "./dates.js";
import { operationAllowed } from "./state.js";
import { page, login, dashboard, confirmation, notice } from "./views.js";

const derive = promisify(scrypt);
const css = readFileSync(new URL("./panel.css", import.meta.url));
const ttl = 8 * 60 * 60_000;
const idPattern =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
function cookieValue(header, key) {
  return (header || "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(key + "="))
    ?.slice(key.length + 1);
}
async function form(req) {
  if (
    (req.headers["content-type"] || "").split(";")[0] !==
    "application/x-www-form-urlencoded"
  )
    throw new Error("form");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error("form");
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  if ([...fields.keys()].length !== new Set(fields.keys()).size)
    throw new Error("form");
  return fields;
}

export function createControlServer({ cfg, store, clock = () => new Date() }) {
  const sessions = new Map(),
    attempts = [];
  const confirmationKey = randomBytes(32);
  const sign = (fields, until) =>
    createHmac("sha256", confirmationKey)
      .update(
        JSON.stringify([
          until,
          ...[
            "csrf",
            "id",
            "action",
            "date",
            "attempt",
            "issue",
            "audience",
          ].map((k) => fields.get(k)),
        ]),
      )
      .digest("hex");
  const cookieName = cfg.secure ? "__Host-digest_owner" : "digest_local";
  const cookie = (value, seconds) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${cfg.secure ? "; Secure" : ""}`;
  return createServer(async (req, res) => {
    const now = clock(),
      ms = now.getTime();
    const csp =
      "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    const send = (code, html, type = "text/html; charset=utf-8") => {
      res.writeHead(code, { "Content-Type": type });
      res.end(html);
    };
    const back = (where) => {
      res.writeHead(303, { Location: where });
      res.end();
    };
    try {
      const url = new URL(req.url, cfg.origin);
      if (req.method === "GET" && url.pathname === "/panel.css")
        return send(200, css, "text/css; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/healthz")
        return send(200, "ok", "text/plain");
      if (!["GET", "POST"].includes(req.method))
        return send(
          405,
          notice("Метод недоступен", "Открой страницу выпуска."),
        );
      if (req.method === "POST" && req.headers.origin !== cfg.origin)
        return send(
          403,
          notice("Запрос отклонён", "Открой панель по её основному адресу."),
        );
      for (const [key, value] of sessions)
        if (value.until <= ms) sessions.delete(key);
      const sid = cookieValue(req.headers.cookie, cookieName),
        session = sessions.get(sid);
      if (req.method === "GET" && url.pathname === "/login")
        return session ? back("/") : send(200, login());
      if (req.method === "POST" && url.pathname === "/login") {
        const fields = await form(req);
        while (attempts.length && attempts[0] <= ms - 60_000) attempts.shift();
        if (attempts.length >= 10)
          return send(
            429,
            login("Слишком много попыток. Попробуй через минуту."),
          );
        attempts.push(ms);
        const password = fields.get("password") || "";
        if (password.length > 1024)
          return send(401, login("Проверь логин и пароль."));
        const hash = await derive(password, cfg.salt, 64);
        if (
          !timingSafeEqual(hash, cfg.hash) ||
          fields.get("user") !== cfg.username
        )
          return send(401, login("Проверь логин и пароль."));
        sessions.delete(sid);
        const key = randomBytes(32).toString("hex");
        if (sessions.size >= 16) sessions.delete(sessions.keys().next().value);
        sessions.set(key, {
          csrf: randomBytes(32).toString("hex"),
          until: ms + ttl,
        });
        res.setHeader("Set-Cookie", cookie(key, ttl / 1000));
        return back("/");
      }
      if (!session) return back("/login");
      const { csrf } = session;
      let fields;
      if (req.method === "POST") {
        fields = await form(req);
        if (fields.get("csrf") !== csrf)
          return send(
            403,
            notice("Сессия изменилась", "Обнови страницу и попробуй снова."),
          );
        if (url.pathname === "/logout") {
          sessions.delete(sid);
          res.setHeader("Set-Cookie", cookie("", 0));
          return back("/login");
        }
      }
      const date = fields
        ? fields.get("date")
        : (url.searchParams.get("date") ?? upcomingDate(cfg.first, now));
      const period = selectableRelease(cfg.first, date, now);
      if (!period)
        return send(
          400,
          notice(
            "На эту дату нет выпуска",
            "Выбери дату отправки из трёхдневного графика.",
          ),
        );
      if (req.method === "GET" && url.pathname === "/preview") {
        const issue = await store.issue(period);
        if (!issue?.cards.length)
          return send(
            404,
            notice(
              "Письмо ещё не готово",
              "Вернись к выпуску.",
              "/?date=" + date,
            ),
          );
        const message = renderCommonDigest({ issues: [issue], ...period });
        res.setHeader(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        return send(200, message.html);
      }
      if (req.method === "GET" && url.pathname === "/")
        return send(
          200,
          dashboard({ cfg, csrf, period, now, data: await store.read(period) }),
        );
      if (
        req.method !== "POST" ||
        !["/confirm", "/action"].includes(url.pathname)
      )
        return send(
          404,
          page(
            "Страница не найдена",
            '<main class="entry"><a href="/">К выпускам</a></main>',
          ),
        );
      const action = fields.get("action"),
        id = fields.get("id"),
        data = await store.read(period);
      if (
        !idPattern.test(id) ||
        !operationAllowed(action, data, date, now) ||
        fields.get("audience") !== cfg.mode + ":" + cfg.listId ||
        (action === "send" &&
          (fields.get("issue") !== data.prep.issue.issueId ||
            fields.get("attempt") !==
              String(data.sender.campaign?.attempt || 0)))
      )
        return send(
          409,
          notice(
            "Состояние выпуска изменилось",
            "Проверь актуальный статус перед действием.",
            "/?date=" + date,
          ),
        );
      if (url.pathname === "/confirm") {
        const until = String(ms + 5 * 60_000);
        fields.set("until", until);
        fields.set("signature", sign(fields, until));
        return send(
          200,
          confirmation({ csrf, cfg, period, data, action, fields }),
        );
      }
      if (
        action !== "check" &&
        (Number(fields.get("until")) <= ms ||
          fields.get("signature") !== sign(fields, fields.get("until")))
      )
        return send(
          409,
          notice(
            "Подтверждение истекло",
            "Открой выпуск и ещё раз проверь выбранное действие.",
            "/?date=" + date,
          ),
        );
      await store.enqueue({
        id,
        action,
        sendDate: date,
        retryAttempt: action === "send" ? Number(fields.get("attempt")) : 0,
      });
      return back("/?date=" + date);
    } catch (error) {
      if (error.message === "form")
        return send(
          400,
          notice("Некорректная форма", "Обнови панель и попробуй снова."),
        );
      console.error("control_request_unavailable");
      return send(
        503,
        notice(
          "Данные временно недоступны",
          "Проверь состояние сервиса и обнови панель перед следующим действием.",
        ),
      );
    }
  });
}
