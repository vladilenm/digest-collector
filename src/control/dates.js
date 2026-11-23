import { commonWindow, validIsoDate } from "../schedule.js";
import { moscowDate, shiftDate } from "../newsletter-period.js";

export function releaseDate(first, date) {
  if (!validIsoDate(first) || !validIsoDate(date) || date < first) return null;
  return commonWindow(new Date(`${date}T12:00:00+03:00`), first);
}

export function upcomingDate(first, now) {
  const today = moscowDate(now);
  if (today < first) return first;
  for (let offset = 0; offset < 3; offset++) {
    const day = shiftDate(today, offset);
    if (releaseDate(first, day)) return day;
  }
  throw new Error("invalid_schedule");
}

export function selectableRelease(first, selected, now) {
  const window = releaseDate(first, selected);
  return window && selected <= upcomingDate(first, now) ? window : null;
}

export function recentDates(first, now, selected) {
  const latest = upcomingDate(first, now);
  const dates = Array.from({ length: 8 }, (_, i) =>
    shiftDate(latest, -3 * i),
  ).filter((date) => date >= first);
  if (selected && !dates.includes(selected)) dates.push(selected);
  return dates;
}

export function eligibleAt(date, hour, now) {
  return (
    now.getTime() >=
    Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00+03:00`)
  );
}
