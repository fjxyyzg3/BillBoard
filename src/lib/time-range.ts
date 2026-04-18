export type RangePreset =
  | "this-month"
  | "last-7-days"
  | "last-30-days"
  | "last-12-months";

const SHANGHAI_OFFSET_HOURS = 8;

export function getRangeBounds(preset: RangePreset, now: Date, timezone: string) {
  if (timezone !== "Asia/Shanghai") {
    throw new Error("v1 supports Asia/Shanghai range math only");
  }

  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_HOURS * 60 * 60 * 1000);

  if (preset === "this-month") {
    const from = new Date(
      Date.UTC(
        shanghaiNow.getUTCFullYear(),
        shanghaiNow.getUTCMonth(),
        1,
        -SHANGHAI_OFFSET_HOURS,
        0,
        0,
        0,
      ),
    );
    const to = new Date(
      Date.UTC(
        shanghaiNow.getUTCFullYear(),
        shanghaiNow.getUTCMonth() + 1,
        0,
        23 - SHANGHAI_OFFSET_HOURS,
        59,
        59,
        999,
      ),
    );

    return { from, to };
  }

  const days = preset === "last-7-days" ? 7 : preset === "last-30-days" ? 30 : 365;
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - (days - 1));

  return { from, to: new Date(now) };
}
