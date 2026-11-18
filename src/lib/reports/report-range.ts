export type ReportRangeMode = "month" | "year" | "all" | "recent" | "custom";

export type ReportRangeSelection = {
  mode: ReportRangeMode;
  month: string;
  year: string;
  start?: string;
  end?: string;
};

export type ReportRangeOptions = {
  months: string[];
  years: string[];
};

export type ReportRange = ReportRangeSelection & {
  from: Date;
  to: Date;
};

const SHANGHAI_OFFSET_HOURS = 8;
const SHANGHAI_OFFSET_MS = SHANGHAI_OFFSET_HOURS * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function padTwoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function getShanghaiDateParts(date: Date) {
  const shanghaiDate = new Date(date.getTime() + SHANGHAI_OFFSET_MS);

  return {
    day: shanghaiDate.getUTCDate(),
    month: shanghaiDate.getUTCMonth() + 1,
    year: shanghaiDate.getUTCFullYear(),
  };
}

function getShanghaiStart(year: number, month: number, day: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);

  return new Date(date.getTime() - SHANGHAI_OFFSET_MS);
}

function getShanghaiEnd(year: number, month: number, day: number) {
  return new Date(getShanghaiStart(year, month, day).getTime() + DAY_MS - 1);
}

function formatMonth(year: number, month: number) {
  return `${String(year).padStart(4, "0")}-${padTwoDigits(month)}`;
}

function formatMonthIndex(monthIndex: number) {
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;

  return formatMonth(year, month);
}

function getMonthIndex(year: number, month: number) {
  return year * 12 + month - 1;
}

function isValidMonth(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) > 0;
}

function isValidYear(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}$/.test(value) && Number(value) > 0;
}

function isReportRangeMode(value: string | null | undefined): value is ReportRangeMode {
  return value === "month" || value === "year" || value === "all" || value === "recent" || value === "custom";
}

export function isValidReportDate(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const actual = getShanghaiDateParts(getShanghaiStart(year, month - 1, day));

  return year > 0 && actual.year === year && actual.month === month && actual.day === day;
}

export function buildSharedReportParams(selection: Partial<ReportRangeSelection>): URLSearchParams {
  const params = new URLSearchParams();
  const validCustom = isValidReportDate(selection.start) && isValidReportDate(selection.end) && selection.start <= selection.end;

  if (isReportRangeMode(selection.mode) && (selection.mode !== "custom" || validCustom)) {
    params.set("mode", selection.mode);
  }

  if (isValidMonth(selection.month)) {
    params.set("month", selection.month);
  }

  if (isValidYear(selection.year)) {
    params.set("year", selection.year);
  }

  if (selection.mode === "custom" && validCustom) {
    params.set("start", selection.start!);
    params.set("end", selection.end!);
  }

  return params;
}

export function parseReportRangeSearchParams(
  params: {
    mode?: string | null;
    month?: string | null;
    year?: string | null;
    start?: string | null;
    end?: string | null;
  },
  now: Date,
): ReportRangeSelection {
  const current = getShanghaiDateParts(now);
  const defaults: ReportRangeSelection = {
    mode: "month",
    month: formatMonth(current.year, current.month),
    year: String(current.year),
  };
  const mode = isReportRangeMode(params.mode) ? params.mode : "month";
  const selection: ReportRangeSelection = {
    mode,
    month: isValidMonth(params.month) ? params.month : defaults.month,
    year: isValidYear(params.year) ? params.year : defaults.year,
  };

  if (mode !== "custom") {
    return selection;
  }

  if (!isValidReportDate(params.start) || !isValidReportDate(params.end) || params.start > params.end) {
    return defaults;
  }

  const today = `${defaults.month}-${padTwoDigits(current.day)}`;

  return { ...selection, start: params.start > today ? today : params.start, end: params.end > today ? today : params.end };
}

export function buildReportRangeOptions(
  firstOccurredAt: Date | null,
  now: Date,
  timezone: string,
): ReportRangeOptions {
  if (timezone !== "Asia/Shanghai") {
    throw new Error("v1 supports Asia/Shanghai report math only");
  }

  const current = getShanghaiDateParts(now);
  const first = firstOccurredAt ? getShanghaiDateParts(firstOccurredAt) : current;
  const currentMonthIndex = getMonthIndex(current.year, current.month);
  const firstMonthIndex = getMonthIndex(first.year, first.month);
  const earliestMonthIndex = Math.min(firstMonthIndex, currentMonthIndex);
  const months: string[] = [];

  for (let monthIndex = currentMonthIndex; monthIndex >= earliestMonthIndex; monthIndex -= 1) {
    months.push(formatMonthIndex(monthIndex));
  }

  const earliestYear = Math.floor(earliestMonthIndex / 12);
  const years: string[] = [];

  for (let year = current.year; year >= earliestYear; year -= 1) {
    years.push(String(year));
  }

  return { months, years };
}

function clampDescendingOption(value: string, options: string[]) {
  if (options.length === 0) {
    return value;
  }

  const newest = options[0] ?? value;
  const oldest = options[options.length - 1] ?? value;

  if (value > newest) {
    return newest;
  }

  if (value < oldest) {
    return oldest;
  }

  return options.includes(value) ? value : newest;
}

export function clampReportRangeSelection(
  selection: ReportRangeSelection,
  options: ReportRangeOptions,
): ReportRangeSelection {
  return {
    ...selection,
    month: clampDescendingOption(selection.month, options.months),
    year: clampDescendingOption(selection.year, options.years),
  };
}

export function getReportRangeBounds(
  selection: ReportRangeSelection,
  now: Date,
  firstOccurredAt: Date | null,
  timezone: string,
) {
  if (timezone !== "Asia/Shanghai") {
    throw new Error("v1 supports Asia/Shanghai report math only");
  }

  const current = getShanghaiDateParts(now);
  const resolved = parseReportRangeSearchParams(selection, now);
  const todayEnd = getShanghaiEnd(current.year, current.month - 1, current.day);

  if (resolved.mode === "month") {
    const [year, month] = resolved.month.split("-").map(Number);

    return {
      from: getShanghaiStart(year, month - 1, 1),
      to: new Date(Math.min(getShanghaiEnd(year, month, 0).getTime(), todayEnd.getTime())),
    };
  }

  if (resolved.mode === "year") {
    const year = Number(resolved.year);

    return {
      from: getShanghaiStart(year, 0, 1),
      to: new Date(Math.min(getShanghaiEnd(year, 12, 0).getTime(), todayEnd.getTime())),
    };
  }

  if (resolved.mode === "recent") {
    return {
      from: getShanghaiStart(current.year, current.month - 3, 1),
      to: todayEnd,
    };
  }

  if (resolved.mode === "custom") {
    const [startYear, startMonth, startDay] = resolved.start!.split("-").map(Number);
    const [endYear, endMonth, endDay] = resolved.end!.split("-").map(Number);

    return {
      from: getShanghaiStart(startYear, startMonth - 1, startDay),
      to: getShanghaiEnd(endYear, endMonth - 1, endDay),
    };
  }

  const first = firstOccurredAt && firstOccurredAt <= todayEnd ? getShanghaiDateParts(firstOccurredAt) : current;

  return {
    from: getShanghaiStart(first.year, first.month - 1, first.day),
    to: todayEnd,
  };
}

function shiftShanghaiMonth(date: Date, months: number, endOfDay: boolean) {
  const original = getShanghaiDateParts(date);
  const target = getShanghaiDateParts(getShanghaiStart(original.year, original.month - 1 + months, 1));
  const lastDay = getShanghaiDateParts(getShanghaiStart(target.year, target.month, 0)).day;
  const day = Math.min(original.day, lastDay);

  return endOfDay ? getShanghaiEnd(target.year, target.month - 1, day) : getShanghaiStart(target.year, target.month - 1, day);
}

function supportedComparisonBounds(from: Date, to: Date): { from: Date; to: Date } | null {
  const earliest = getShanghaiStart(1, 0, 1).getTime();
  const latest = getShanghaiEnd(9999, 11, 31).getTime();

  return from.getTime() >= earliest && to.getTime() <= latest && from.getTime() <= to.getTime()
    ? { from, to }
    : null;
}

export function getReportComparisonBounds(
  range: ReportRange,
  kind: "previous" | "yearAgo",
  now: Date,
): { from: Date; to: Date } | null {
  if (range.mode === "all") {
    return null;
  }

  if (kind === "yearAgo" || range.mode === "year") {
    return supportedComparisonBounds(shiftShanghaiMonth(range.from, -12, false), shiftShanghaiMonth(range.to, -12, true));
  }

  if (range.mode === "custom") {
    const duration = range.to.getTime() - range.from.getTime() + 1;

    return supportedComparisonBounds(new Date(range.from.getTime() - duration), new Date(range.from.getTime() - 1));
  }

  if (range.mode === "recent") {
    return supportedComparisonBounds(shiftShanghaiMonth(range.from, -3, false), shiftShanghaiMonth(range.to, -3, true));
  }

  const current = getShanghaiDateParts(now);
  const selected = getShanghaiDateParts(range.from);
  const completed = getMonthIndex(selected.year, selected.month) < getMonthIndex(current.year, current.month);

  return supportedComparisonBounds(
    shiftShanghaiMonth(range.from, -1, false),
    completed
      ? getShanghaiEnd(selected.year, selected.month - 1, 0)
      : shiftShanghaiMonth(range.to, -1, true),
  );
}
