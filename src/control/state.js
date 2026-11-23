import { eligibleAt } from "./dates.js";

export function online(heartbeat, now) {
  const age = now.getTime() - new Date(heartbeat?.seen_at || 0).getTime();
  return age >= -30_000 && age < 90_000;
}
const active = (request) => ["queued", "running"].includes(request?.state);

export function operationAllowed(action, { prep, sender }, date, now) {
  if (action === "prepare")
    return Boolean(
      prep &&
      !prep.issue &&
      prep.preparation?.state !== "running" &&
      !active(prep.request) &&
      online(prep.heartbeat, now) &&
      eligibleAt(date, 9, now),
    );
  if (!sender || !online(sender.heartbeat, now) || active(sender.request))
    return false;
  const row = sender.campaign;
  if (action === "check")
    return Boolean(
      row &&
      (row.campaign_id ||
        row.message_id ||
        ["preparing", "draft", "sending", "uncertain", "accepted"].includes(
          row.state,
        )),
    );
  if (
    action !== "send" ||
    !eligibleAt(date, 10, now) ||
    prep?.issue?.status !== "ready" ||
    !prep.issue.cards.length
  )
    return false;
  return (
    !row ||
    (row.state === "failed" &&
      row.failure_code === "unisender_rejected" &&
      !row.campaign_id)
  );
}

const reasons = {
  WORKER_INTERRUPTED:
    "Процесс остановился во время подготовки. После восстановления можно повторить.",
  INVALID_SEND_DATE: "Дата не соответствует графику подготовки.",
  journal_unavailable:
    "Не удалось обновить журнал отправщика. Проверь базу и сверь кампанию.",
  ARCHIVE_MISSING_DAYS:
    "В архиве нет материалов за один или несколько дней. Проверь сбор источников в Topic Digest.",
  NO_MATERIALS: "За этот период в архиве пока нет материалов.",
  LLM_PROVIDER_FAILED:
    "Сервис редакторской модели не ответил. Подготовку можно повторить.",
  EDITORIAL_AUDIT_FAILED:
    "Выпуск не прошёл редакторскую проверку. Повтори подготовку.",
  PREPARATION_FAILED:
    "Подготовка прервалась. Подробности есть в журнале Topic Digest.",
  WORKER_BUSY: "Topic Digest обрабатывает другой выпуск.",
  INVALID_JSON: "Редакторская модель вернула нечитаемый ответ.",
  INVALID_STRUCTURE: "Структура подготовленного выпуска не прошла проверку.",
  CONTEXT_BUDGET_EXCEEDED:
    "Объём материалов превышает лимит редакторской модели.",
  not_enough_money: "На счёте Unisender недостаточно средств.",
  invalid_api_key: "Unisender отклонил ключ API. Проверь настройки отправщика.",
  access_denied: "У отправщика нет нужных прав в Unisender.",
  invalid_arg:
    "Unisender отклонил параметры запроса. Проверь настройки письма и списка.",
  api_call_limit_exceeded_for_api_key:
    "Достигнут лимит запросов по ключу API. Повтори отправку позже.",
  api_call_limit_exceeded_for_ip:
    "Достигнут лимит запросов с адреса отправщика. Подожди перед повтором.",
  campaign_declined:
    "Unisender отклонил кампанию на модерации. Открой её отчёт.",
  campaign_canceled:
    "Кампания отменена. Проверь отчёт о возможной частичной доставке.",
  not_due: "Дата выпуска вне разрешённого окна.",
  campaign_missing: "В журнале нет кампании за этот выпуск.",
  campaign_changed: "Состояние кампании уже изменилось. Обнови страницу.",
  skipped: "Выпуск пропущен.",
  source_failed: "Не удалось прочитать материалы выпуска.",
  unisender_rejected:
    "Unisender отклонил запрос. Проверь настройки аккаунта и доступный лимит.",
  unisender_timeout:
    "Истекло время ответа Unisender. Проверь, создана ли кампания.",
  unisender_network_error: "Оборвалась связь с Unisender.",
  unisender_provider_error:
    "Unisender вернул ошибку. Требуется сверка кампании.",
  unisender_campaign_exists: "Unisender сообщил о существующей кампании.",
  journal_write_failed: "Не удалось сохранить результат в журнале.",
  window_closed: "Окно плановой отправки закончилось.",
  worker_interrupted: "Процесс прервался при выполнении команды.",
  worker_stale:
    "Отправщик потерял связь. Проверь его состояние и повторно подтверди действие.",
  provider_unavailable: "Сервис Unisender временно недоступен.",
  match_missing:
    "Связанная кампания пока не найдена. Повторная отправка заблокирована.",
  match_ambiguous:
    "Найдено несколько подходящих кампаний. Нужна ручная сверка.",
  report_pending: "Unisender ещё не предоставил статистику.",
  checked: "Состояние сверено с Unisender.",
  already_claimed: "У выпуска уже есть запись об отправке.",
  accepted: "Unisender принял кампанию.",
  uncertain: "Подтверждение от Unisender не получено.",
  awaiting_issue: "Отправщик ожидает готовый выпуск.",
  failed: "Команда завершилась ошибкой.",
};
export function reason(code) {
  return Object.hasOwn(reasons, code)
    ? reasons[code]
    : typeof code === "string" && /^[a-z0-9_-]{1,80}$/i.test(code)
      ? `Код · ${code}`
      : "";
}

export function summary({ prep, sender }, date, now) {
  const issue = prep?.issue,
    row = sender?.campaign,
    outcome = prep?.preparation;
  const preparation = !prep
    ? ["Нет связи с базой", "bad"]
    : issue
      ? issue.status === "empty"
        ? ["Пустой выпуск", "quiet"]
        : ["Выпуск готов", "good"]
      : active(prep.request) || outcome?.state === "running"
        ? ["Идёт подготовка", "wait"]
        : outcome?.state === "failed"
          ? ["Ошибка подготовки", "bad"]
          : [
              eligibleAt(date, 9, now)
                ? "Выпуск ещё не готов"
                : "По расписанию в 09:00",
              "quiet",
            ];
  const deliveryStates = {
    preparing: ["Готовится отправка", "wait"],
    draft: ["Черновик создан", "wait"],
    sending: ["Запрос отправлен", "wait"],
    uncertain: ["Нужна сверка", "bad"],
    failed: ["Отправка прервана", "bad"],
    skipped: ["Отправка пропущена", "quiet"],
    accepted: ["Принято Unisender", "good"],
  };
  const sending = !sender
    ? ["Нет связи с журналом", "bad"]
    : active(sender.request)
      ? ["Команда в работе", "wait"]
      : row
        ? deliveryStates[row.state] || ["Статус неизвестен", "quiet"]
        : ["Кампания ещё не создана", "quiet"];
  const stats =
    row?.delivered_count != null
      ? [
          `Доставлено · ${row.delivered_count}`,
          row.delivered_count > 0 ? "good" : "quiet",
        ]
      : [row?.campaign_id ? "Ожидаем отчёт" : "Пока нет отчёта", "quiet"];
  return { preparation, sending, stats };
}
