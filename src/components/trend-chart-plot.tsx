"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { formatFen } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

export type TrendView = "cashflow" | "balance" | "cumulative";
export type TrendPoint = {
  key: string;
  label: string;
  axisLabel?: string;
  rangeLabel?: string;
  incomeFen: number;
  expenseFen: number;
  netFen?: number;
  cumulativeNetFen?: number;
  transactionCount: number;
  href?: string;
};

export type TrendChartPlotLabels = {
  income: string;
  expense: string;
  tx: string;
  hint: string;
  viewRecords: string;
  unit?: string;
  net?: string;
  cumulative?: string;
};

type TrendChartPlotProps = {
  points: TrendPoint[];
  locale?: Locale;
  labels: TrendChartPlotLabels;
  view?: TrendView;
};

type SeriesKey = "incomeFen" | "expenseFen" | "netFen" | "cumulativeNetFen";
const CHART_HEIGHT = 168;
const CHART_PADDING = 8;

function pointValue(point: TrendPoint, key: SeriesKey) {
  if (key === "netFen") return point.netFen ?? point.incomeFen - point.expenseFen;
  if (key === "cumulativeNetFen") return point.cumulativeNetFen ?? 0;
  return point[key];
}

function formatMoney(fen: number, numberFormat?: Intl.NumberFormat) {
  return `${fen < 0 ? "−" : ""}¥${numberFormat ? numberFormat.format(Math.abs(fen) / 100) : formatFen(Math.abs(fen))}`;
}

function subscribeToHydration() {
  return () => {};
}

function getHydratedSnapshot() {
  return true;
}

function getServerHydrationSnapshot() {
  return false;
}

function tickStep(span: number) {
  const target = Math.max(10000, span) / 3;
  const power = 10 ** Math.floor(Math.log10(target));
  return ([1, 2, 2.5, 5, 10].find((value) => value * power >= target) ?? 10) * power;
}

export function TrendChartPlot({ points, labels, locale = "zh-CN", view = "cashflow" }: TrendChartPlotProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const isHydrated = useSyncExternalStore(subscribeToHydration, getHydratedSnapshot, getServerHydrationSnapshot);
  const selectedIndex = points.findIndex((point) => point.key === selectedKey);
  const selected = points[selectedIndex];
  const series: { key: SeriesKey; color: string }[] = view === "cashflow"
    ? [{ key: "incomeFen", color: "var(--bb-income)" }, { key: "expenseFen", color: "var(--bb-coral)" }]
    : [{ key: view === "balance" ? "netFen" : "cumulativeNetFen", color: "var(--bb-primary)" }];
  const values = points.flatMap((point) => series.map((item) => pointValue(point, item.key)));
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const step = tickStep(high - low);
  const minFen = Math.floor(low / step) * step;
  const maxFen = Math.max(minFen + step, Math.ceil(high / step) * step);
  const ticks: number[] = [];
  for (let value = maxFen; value >= minFen; value -= step) ticks.push(value);
  const tickIndices = points.length ? Array.from(new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1])) : [];
  const axisFormat = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const numberFormat = view === "cashflow" ? undefined : new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const chartX = (index: number) => points.length > 1 ? index / (points.length - 1) * 1000 : 500;
  const chartY = (value: number) => CHART_PADDING + (maxFen - value) / (maxFen - minFen) * (CHART_HEIGHT - CHART_PADDING * 2);
  const linePoints = (key: SeriesKey) => points.map((point, index) => `${chartX(index)},${chartY(pointValue(point, key))}`).join(" ");
  const current = points[selectedIndex < 0 ? 0 : selectedIndex];
  const valueText = current ? view === "cashflow"
    ? `${current.label}, ${labels.income} ${formatMoney(current.incomeFen)}, ${labels.expense} ${formatMoney(current.expenseFen)}`
    : `${current.label}, ${view === "balance" ? labels.net : labels.cumulative} ${formatMoney(pointValue(current, view === "balance" ? "netFen" : "cumulativeNetFen"), numberFormat)}` : undefined;

  function select(index: number) {
    const point = points[Math.max(0, Math.min(points.length - 1, index))];
    if (point) setSelectedKey(point.key);
  }

  return (
    <div className="mt-4 min-w-0 space-y-2" data-trend-view={view}>
      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--bb-muted)]">
        <p>{labels.hint}</p>
        <span>{labels.unit ?? "¥"}</span>
      </div>
      <div className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-2">
        <div aria-hidden="true" className="relative h-44 whitespace-nowrap text-right text-[10px] tabular-nums text-[var(--bb-muted)] sm:h-48">
          {ticks.map((value) => (
            <span className="absolute right-0 -translate-y-1/2" key={value} style={{ top: `${chartY(value) / CHART_HEIGHT * 100}%` }}>{axisFormat.format(value / 100)}</span>
          ))}
        </div>
        <div className="min-w-0">
          <div className="relative h-44 rounded focus-within:outline-2 focus-within:outline-offset-4 focus-within:outline-[var(--bb-primary)] sm:h-48" data-testid="trend-plot">
            <ul aria-hidden="true" className="absolute inset-0 flex min-w-0">
              {points.map((point, index) => <li className={`h-full min-w-0 flex-1 ${selectedIndex === index ? "bg-[var(--bb-accent-soft)]" : ""}`} data-testid="trend-point" key={point.key} />)}
            </ul>
            <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" preserveAspectRatio="none" viewBox={`0 0 1000 ${CHART_HEIGHT}`}>
              {ticks.map((value) => <line data-testid={value === 0 ? "trend-zero-axis" : undefined} key={value} stroke={value === 0 ? "var(--bb-line-strong)" : "var(--bb-warm-line)"} strokeWidth="1" vectorEffect="non-scaling-stroke" x1="0" x2="1000" y1={chartY(value)} y2={chartY(value)} />)}
              {series.map((item) => <polyline fill="none" key={item.key} points={linePoints(item.key)} stroke={item.color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.25" vectorEffect="non-scaling-stroke" />)}
              {selected ? <line stroke="var(--bb-line-strong)" strokeDasharray="3 4" strokeWidth="1" vectorEffect="non-scaling-stroke" x1={chartX(selectedIndex)} x2={chartX(selectedIndex)} y1={CHART_PADDING} y2={CHART_HEIGHT - CHART_PADDING} /> : null}
              {series.flatMap((item) => points.map((point, index) => (
                <line
                  data-testid="trend-series-point"
                  key={`${item.key}:${point.key}`}
                  stroke={item.color}
                  strokeLinecap="round"
                  strokeWidth={selectedIndex === index ? "6" : points.length === 1 ? "5" : "3"}
                  vectorEffect="non-scaling-stroke"
                  x1={chartX(index)}
                  x2={chartX(index)}
                  y1={chartY(pointValue(point, item.key))}
                  y2={chartY(pointValue(point, item.key)) + 0.01}
                />
              )))}
            </svg>
            <input
              aria-label={labels.hint}
              aria-valuetext={valueText}
              className="absolute inset-0 m-0 h-full w-full touch-pan-y cursor-crosshair opacity-0"
              data-testid="trend-date-picker"
              disabled={!isHydrated || points.length === 0}
              max={Math.max(0, points.length - 1)}
              min={0}
              onChange={(event) => select(Number(event.target.value))}
              onKeyDown={(event) => {
                const index = selectedIndex < 0 ? 0 : selectedIndex;
                const next = event.key === "Home" ? 0
                  : event.key === "End" ? points.length - 1
                  : event.key === "ArrowLeft" || event.key === "ArrowDown" ? index - 1
                  : event.key === "ArrowRight" || event.key === "ArrowUp" ? index + 1
                  : undefined;
                if (next !== undefined) {
                  event.preventDefault();
                  select(next);
                }
              }}
              onPointerDown={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                select(Math.round((event.clientX - bounds.left) / Math.max(1, bounds.width) * (points.length - 1)));
              }}
              step={1}
              type="range"
              value={selectedIndex < 0 ? 0 : selectedIndex}
            />
          </div>
          <div aria-hidden="true" className={`mt-2 flex min-w-0 gap-1 text-[10px] text-[var(--bb-muted)] ${points.length === 1 ? "justify-center" : "justify-between"}`}>
            {tickIndices.map((index) => <span className="min-w-0 whitespace-nowrap" key={index}>{points[index]?.axisLabel ?? points[index]?.label}</span>)}
          </div>
        </div>
      </div>
      {selected ? (
        <div aria-atomic="true" aria-live="polite" className="rounded-xl bg-[var(--bb-warm-surface)] px-3 py-3 text-sm" data-testid="trend-detail">
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <p className="font-semibold text-[var(--bb-ink)]">{selected.label}</p>
            <span className="text-xs text-[var(--bb-muted)]">{selected.transactionCount} {labels.tx}</span>
          </div>
          {selected.rangeLabel ? <p className="mt-0.5 text-[10px] leading-5 text-[var(--bb-muted)]">{selected.rangeLabel}</p> : null}
          <div className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-3 tabular-nums sm:grid-cols-3">
            <p className="min-w-0 text-[var(--bb-income-ink)]"><span className="block text-[10px] text-[var(--bb-muted)]">{labels.income}</span>{" "}<span className="break-all">{formatMoney(selected.incomeFen, numberFormat)}</span></p>
            <p className="min-w-0 text-[var(--bb-ink)]"><span className="block text-[10px] text-[var(--bb-muted)]">{labels.expense}</span>{" "}<span className="break-all">{formatMoney(selected.expenseFen, numberFormat)}</span></p>
            {view !== "cashflow" ? <p className={`min-w-0 ${pointValue(selected, "netFen") < 0 ? "text-[var(--bb-danger)]" : "text-[var(--bb-ink)]"}`}><span className="block text-[10px] text-[var(--bb-muted)]">{labels.net}</span>{" "}<span className="break-all">{formatMoney(pointValue(selected, "netFen"), numberFormat)}</span></p> : null}
            {view === "cumulative" ? <p className={`min-w-0 ${pointValue(selected, "cumulativeNetFen") < 0 ? "text-[var(--bb-danger)]" : "text-[var(--bb-ink)]"}`}><span className="block text-[10px] text-[var(--bb-muted)]">{labels.cumulative}</span>{" "}<span className="break-all">{formatMoney(pointValue(selected, "cumulativeNetFen"), numberFormat)}</span></p> : null}
          </div>
          {selected.href && selected.transactionCount > 0 ? (
            <Link className="bb-tap mt-1 inline-flex min-h-11 items-center text-xs font-semibold text-[var(--bb-primary)]" href={selected.href}>
              {labels.viewRecords} ›
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
