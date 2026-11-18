import { DateTime } from "luxon";

export const ZONE = "Asia/Kolkata";

export function date(value: string): DateTime {
  const result = DateTime.fromFormat(value, "yyyy-MM-dd", { zone: ZONE });
  if (!result.isValid) throw new Error(`Invalid IST date: ${value}`);
  return result;
}

export function timestamp(value: string): DateTime {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value))
    throw new Error(`Invalid IST timestamp: ${value}`);
  const result = DateTime.fromSQL(value, { zone: ZONE });
  if (!result.isValid) throw new Error(`Invalid IST timestamp: ${value}`);
  return result;
}

export function inHistory(day: string, asOf: string, days: number): boolean {
  const current = date(day);
  const end = date(asOf);
  return current >= end.minus({ days }) && current < end;
}

export function calendarDays(first: string, later: string): number {
  return date(later).diff(date(first), "days").days;
}
