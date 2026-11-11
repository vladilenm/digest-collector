const dayMs = 86_400_000;
const moscow = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

export function validIsoDate(value) {
  if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function commonWindow(now, firstSendDate) {
  if (!validIsoDate(firstSendDate)) throw new Error("invalid_first_send_date");
  const parts = Object.fromEntries(moscow.formatToParts(now).map(({ type, value }) => [type, value]));
  const sendDate = `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
  const day = Date.parse(sendDate);
  const elapsed = (day - Date.parse(firstSendDate)) / dayMs;
  if (Number(parts.hour) < 10 || elapsed < 0 || elapsed % 3 !== 0) return null;
  const offset = (days) => new Date(day + days * dayMs).toISOString().slice(0, 10);
  return { sendDate, fromDate: offset(-3), toDate: offset(-1) };
}
