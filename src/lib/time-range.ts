export type RangePreset =
  | "this-month"
  | "last-7-days"
  | "last-30-days"
  | "last-12-months";

const SHANGHAI_OFFSET_HOURS = 8;
const SHANGHAI_OFFSET_MS = SHANGHAI_OFFSET_HOURS * 60 * 60 * 1000;

function getShanghaiCalendarDate(now: Date) {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS);
}

function getShanghaiStart(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day, -SHANGHAI_OFFSET_HOURS, 0, 0, 0));
}

function getShanghaiEnd(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day, 23 - SHANGHAI_OFFSET_HOURS, 59, 59, 999));
}

export function getRangeBounds(preset: RangePreset, now: Date, timezone: string) {
  if (timezone !== "Asia/Shanghai") {
    throw new Error("v1 supports Asia/Shanghai range math only");
  }

  const shanghaiNow = getShanghaiCalendarDate(now);
  const year = shanghaiNow.getUTCFullYear();
  const month = shanghaiNow.getUTCMonth();
  const day = shanghaiNow.getUTCDate();

  if (preset === "this-month") {
    const from = getShanghaiStart(year, month, 1);
    const to = getShanghaiEnd(year, month + 1, 0);

    return { from, to };
  }

  if (preset === "last-12-months") {
    const from = getShanghaiStart(year, month - 11, 1);
    const to = getShanghaiEnd(year, month + 1, 0);

    return { from, to };
  }

  const days = preset === "last-7-days" ? 7 : 30;
  const from = getShanghaiStart(year, month, day - (days - 1));
  const to = getShanghaiEnd(year, month, day);

  return { from, to };
}
