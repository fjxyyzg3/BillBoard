const SHANGHAI_OFFSET_HOURS = 8;
const SHANGHAI_OFFSET_MS = SHANGHAI_OFFSET_HOURS * 60 * 60 * 1000;
const DATETIME_LOCAL_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})$/;

function padTwoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function formatShanghaiDateTimeParts(date: Date) {
  const shanghaiDate = new Date(date.getTime() + SHANGHAI_OFFSET_MS);

  return {
    year: shanghaiDate.getUTCFullYear(),
    month: shanghaiDate.getUTCMonth() + 1,
    day: shanghaiDate.getUTCDate(),
    hour: shanghaiDate.getUTCHours(),
    minute: shanghaiDate.getUTCMinutes(),
  };
}

export function getCurrentShanghaiDateTimeLocal(now: Date = new Date()) {
  const parts = formatShanghaiDateTimeParts(now);

  return `${parts.year}-${padTwoDigits(parts.month)}-${padTwoDigits(parts.day)}T${padTwoDigits(
    parts.hour,
  )}:${padTwoDigits(parts.minute)}`;
}

export function parseShanghaiDateTimeLocal(input: string) {
  const match = DATETIME_LOCAL_PATTERN.exec(input);

  if (!match?.groups) {
    throw new Error("Choose a valid date and time");
  }

  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour - SHANGHAI_OFFSET_HOURS, minute));

  if (getCurrentShanghaiDateTimeLocal(parsed) !== input) {
    throw new Error("Choose a valid date and time");
  }

  return parsed;
}
