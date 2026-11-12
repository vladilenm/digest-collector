// Mirrored from topic-monitor email-period v1; keep in sync with producer.
import { z } from "zod";
export const CalendarDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (Number.isFinite(date.getTime()) &&
        date.toISOString().slice(0, 10) === value);
}, "invalid calendar date");
const DAY = 86_400_000;
export const moscowDate = (date) => new Date(date.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
export const shiftDate = (date, days) => new Date(Date.parse(`${CalendarDate.parse(date)}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
export function previousThreeDays(now = new Date()) {
    const today = moscowDate(now);
    return { fromDate: shiftDate(today, -3), toDate: shiftDate(today, -1) };
}
export function newsletterPeriod(fromDate, toDate, now = new Date()) {
    CalendarDate.parse(fromDate);
    CalendarDate.parse(toDate);
    if (fromDate > toDate)
        throw new Error("newsletter period is reversed");
    if (toDate >= moscowDate(now))
        throw new Error("newsletter requires completed Moscow calendar days");
    return {
        fromDate,
        toDate,
        timezone: "Europe/Moscow",
        startAt: new Date(`${fromDate}T00:00:00+03:00`).toISOString(),
        endBefore: new Date(`${shiftDate(toDate, 1)}T00:00:00+03:00`).toISOString(),
    };
}
export function datesInPeriod(period) {
    const dates = [];
    for (let day = period.fromDate; day <= period.toDate; day = shiftDate(day, 1))
        dates.push(day);
    return dates;
}
