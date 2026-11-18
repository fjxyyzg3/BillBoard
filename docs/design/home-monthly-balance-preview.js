/* Offline, fictional fixtures. No application services or stored user data are used. */
(() => {
  "use strict";

  const TODAY = "2026-11-06";
  const state = { locale: "zh-CN", range: "year", scenario: "normal", member: "all", ledger: "all", view: "cashflow", selected: null };
  const $ = (id) => document.getElementById(id);
  const dictionary = {
    previewTitle: ["首页趋势", "Home trends"], offline: ["离线预览 · 示例数据", "Offline preview · Sample data"],
    scenarioLabel: ["示例", "Data"], scenarioAria: ["示例数据场景", "Sample data scenario"], normal: ["日常收支", "Everyday spending"], deficit: ["负结余", "Negative balance"], gaps: ["含空月份", "Months with no records"], empty: ["无记录", "No records"],
    deviceAria: ["预览尺寸", "Preview size"], desktop: ["桌面", "Desktop"], phone: ["手机", "Phone"], shellAria: ["应用外观示意", "Application context"], navAria: ["页面位置示意", "Page context"],
    tagline: ["把日子记清楚。", "A clearer picture of daily life."], home: ["首页", "Home"], records: ["记录", "Records"], account: ["账号", "Account"], householdName: ["小林的家庭", "Lin’s household"], twoMembers: ["2 位成员 · 示例家庭", "2 members · Sample household"],
    rangeAria: ["统计时间范围", "Report date range"], rangeYear: ["2026 年 · 按月查看", "2026 · Monthly view"], rangeRecent: ["最近三个月", "Last 3 months"], rangeMonth: ["2026 年 11 月 · 截至 6 日", "November 2026 · Through Nov 6"], rangeCustom: ["自定义 · 5 月 10 日至 6 月 6 日", "Custom · May 10 – Jun 6"], rangeAll: ["全部记录", "All records"],
    memberAria: ["归属成员", "Attributed member"], household: ["全家", "Household"], lin: ["小林", "Lin"], xia: ["小夏", "Xia"], ledgerAria: ["查看账本", "Ledger scope"], allLedgers: ["全部账本", "All ledgers"], dailyLedger: ["日常账本", "Everyday ledger"], travelLedger: ["旅行账本 · 已归档", "Travel ledger · Archived"],
    selectedExpense: ["所选范围支出", "Expenses in this period"], income: ["收入", "Income"], expense: ["支出", "Expenses"], net: ["结余", "Net"], trend: ["趋势", "Trends"], viewAria: ["趋势视图", "Trend view"], cashflow: ["收支趋势", "Cash flow"], balance: ["结余趋势", "Net trend"], cumulative: ["累计结余", "Cumulative net"],
    pickMonth: ["点选月份查看详情", "Select a month for details"], pickDay: ["点选日期查看详情", "Select a day for details"], unit: ["单位：元", "Unit: CNY"], pickerAria: ["选择数据点，方向键切换", "Choose a data point using the arrow keys"], viewMonthRecords: ["查看当月记录", "View month’s records"], viewDayRecords: ["查看当日记录", "View day’s records"],
    categories: ["分类分析", "Categories"], totalExpense: ["总支出", "Total expenses"], noExpense: ["这个范围内没有支出记录", "No expenses in this period"], footnote: ["示例日期 2026-11-06 · 数据均为虚构，仅供界面预览。", "Sample date: Nov 6, 2026 · All data is fictional, for visual preview only."],
    sampleRecords: ["虚构示例明细，不连接真实账本", "Fictional records. No connection to a real ledger."], close: ["关闭明细", "Close records"],
    food: ["餐饮", "Food & dining"], householdCategory: ["居家", "Household"], shopping: ["购物", "Shopping"], transport: ["交通", "Transport"], leisure: ["休闲", "Leisure"], bills: ["生活缴费", "Bills"], other: ["其他", "Other"], salary: ["工资收入", "Salary"],
    currentNet: ["当月结余", "Month’s net"], dayNet: ["当日结余", "Day’s net"], endNet: ["范围末累计结余", "Cumulative net at period end"],
    cashflowMonthNote: ["按月汇总所选范围的收入与支出。", "Monthly income and expenses within the selected period."], cashflowDayNote: ["按日展示所选月份的收入与支出。", "Daily income and expenses in the selected month."], balanceNote: ["按月展示收入减支出的结余，各月独立统计。", "Each point is that month’s income minus expenses within the selected period."], cumulativeNote: ["从所选范围以 0 开始，逐月累计收入减支出。", "Starts at zero in the selected period. Adds each month’s income minus expenses."],
    balanceFooter: ["每个点对应当月结余；部分月份仅统计所选日期。", "Each point shows that month’s net. Partial months include selected dates only."], cumulativeFooter: ["末点与上方结余一致，不含范围外的历史结余。", "The last point matches the net above. Earlier balances are excluded."], noRecords: ["所选范围暂无记录，结余按 0 计算。", "No records in this period. Recorded net is zero."],
  };
  const t = (key) => dictionary[key]?.[state.locale === "zh-CN" ? 0 : 1] ?? key;
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const number = (fen) => new Intl.NumberFormat(state.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(fen) / 100);
  const money = (fen, signed = false) => `${fen < 0 ? "−" : signed && fen > 0 ? "+" : ""}¥${number(fen)}`;
  const amount = (fen) => `${fen < 0 ? "−" : ""}${number(fen)}`;
  const monthName = (key, year = false) => new Intl.DateTimeFormat(state.locale, { month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "Asia/Shanghai" }).format(new Date(`${key}-01T12:00:00+08:00`));
  const dateName = (date, year = false) => new Intl.DateTimeFormat(state.locale, { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "Asia/Shanghai" }).format(new Date(`${date}T12:00:00+08:00`));
  const dateRange = (from, to, year = false) => from === to ? dateName(from, year) : `${dateName(from, year)} – ${dateName(to, year)}`;
  const countLabel = (count) => state.locale === "zh-CN" ? `${count} 笔记录` : `${count} ${count === 1 ? "record" : "records"}`;
  const dateString = (year, month, day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

  function fixtures() {
    if (state.scenario === "empty") return [];
    const totals = [[2880000, 1945000], [2960000, 2086000], [3000000, 2384000], [3000000, 1786000], [3100000, 3195000], [3100000, 1968000], [3220000, 2146000], [3200000, 2878000], [3200000, 1912000], [3200000, 2206000], [3250000, 2280000], [1660000, 452000]];
    const categories = ["food", "householdCategory", "shopping", "transport", "leisure", "bills", "other"];
    const weights = [27, 22, 16, 12, 10, 7, 6];
    const rows = [];
    totals.forEach(([income, expense], index) => {
      const year = index === 0 ? 2025 : 2026;
      const month = index === 0 ? 12 : index;
      if (state.scenario === "gaps" && year === 2026 && [4, 7].includes(month)) return;
      if (state.scenario === "deficit") income = Math.round(income * 22 / 100);
      const firstIncome = Math.round(income * 55 / 100);
      [firstIncome, income - firstIncome].forEach((value, member) => rows.push({ date: dateString(year, month, member ? 5 : month === 11 ? 1 : 2), type: "income", amountFen: value, member: member ? "xia" : "lin", ledger: "daily", category: "salary" }));
      let assigned = 0;
      const days = month === 11 ? [1, 2, 3, 4, 5, 6, 6] : [3, 6, 9, 13, 18, 23, 28];
      weights.forEach((weight, item) => {
        const value = item === weights.length - 1 ? expense - assigned : Math.round(expense * weight / 100);
        assigned += value;
        rows.push({ date: dateString(year, month, days[item]), type: "expense", amountFen: value, member: item % 2 ? "xia" : "lin", ledger: year === 2026 && [2, 5, 7, 10].includes(month) && [3, 4].includes(item) ? "travel" : "daily", category: categories[item] });
      });
    });
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  }

  function getRange(allRows) {
    if (state.range === "month") return { from: "2026-11-01", to: TODAY };
    if (state.range === "recent") return { from: "2026-09-01", to: TODAY };
    if (state.range === "custom") return { from: "2026-05-10", to: "2026-06-06" };
    if (state.range === "all") return { from: allRows[0]?.date ?? "2026-11-01", to: TODAY };
    return { from: "2026-01-01", to: TODAY };
  }

  function totals(rows, from, to) {
    const result = { incomeFen: 0, expenseFen: 0, transactionCount: 0 };
    rows.forEach((row) => {
      if (row.date < from || row.date > to) return;
      result[row.type === "income" ? "incomeFen" : "expenseFen"] += row.amountFen;
      result.transactionCount++;
    });
    return { ...result, netFen: result.incomeFen - result.expenseFen };
  }

  function model() {
    const ledgerRows = fixtures().filter((row) => state.ledger === "all" || row.ledger === state.ledger);
    const rows = ledgerRows.filter((row) => state.member === "all" || row.member === state.member);
    const range = getRange(ledgerRows);
    const summary = totals(rows, range.from, range.to);
    let effectiveFrom = range.from;
    if (state.range === "custom") effectiveFrom = [range.from, `${(ledgerRows[0]?.date ?? range.to).slice(0, 7)}-01`].sort()[1];
    const [firstYear, firstMonth] = effectiveFrom.split("-").map(Number);
    const [finalYear, finalMonth] = range.to.split("-").map(Number);
    const monthly = [];
    let cumulativeNetFen = 0;
    for (let index = firstYear * 12 + firstMonth - 1; index <= finalYear * 12 + finalMonth - 1; index++) {
      const year = Math.floor(index / 12);
      const month = index % 12 + 1;
      const key = dateString(year, month, 1).slice(0, 7);
      const from = [dateString(year, month, 1), effectiveFrom].sort()[1];
      const to = [dateString(year, month, lastDay(year, month)), range.to].sort()[0];
      const current = totals(rows, from, to);
      cumulativeNetFen += current.netFen;
      monthly.push({ key, from, to, ...current, cumulativeNetFen });
    }
    const daily = [];
    if (state.range === "month") {
      for (let day = 1; day <= 6; day++) {
        const date = dateString(2026, 11, day);
        daily.push({ key: date, from: date, to: date, ...totals(rows, date, date) });
      }
    }
    return { range, rows, summary, monthly, points: state.view === "cashflow" && state.range === "month" ? daily : monthly };
  }

  function applyLocale() {
    document.documentElement.lang = state.locale;
    document.title = state.locale === "zh-CN" ? "BillBoard · 首页月度结余预览" : "BillBoard · Monthly balance preview";
    document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
    document.querySelectorAll("[data-i18n-label]").forEach((node) => { node.setAttribute("aria-label", t(node.dataset.i18nLabel)); });
    $("locale-button").textContent = state.locale === "zh-CN" ? "EN" : "中文";
    $("locale-button").setAttribute("aria-label", state.locale === "zh-CN" ? "Switch to English" : "切换为中文");
  }

  function render() {
    applyLocale();
    const data = model();
    const heading = { year: state.locale === "zh-CN" ? "2026 年" : "2026", month: monthName("2026-11", true), recent: t("rangeRecent"), custom: state.locale === "zh-CN" ? "自定义范围" : "Custom range", all: t("rangeAll") };
    $("range-heading").textContent = heading[state.range];
    $("range-caption").textContent = dateRange(data.range.from, data.range.to, true);
    $("total-expense").textContent = number(data.summary.expenseFen);
    $("total-income").textContent = number(data.summary.incomeFen);
    $("total-net").textContent = amount(data.summary.netFen);
    $("net-summary").classList.toggle("deficit", data.summary.netFen < 0);
    $("total-count").textContent = countLabel(data.summary.transactionCount);
    document.querySelectorAll("[data-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === state.view)));
    const last = data.monthly.at(-1);
    let label = t("selectedExpense");
    let value = money(data.summary.expenseFen);
    let note = t(state.range === "month" ? "cashflowDayNote" : "cashflowMonthNote");
    let legend = `<span><i class="legend-dot income-dot"></i>${t("income")}</span><span><i class="legend-dot expense-dot"></i>${t("expense")}</span>`;
    if (state.view === "cumulative") {
      label = t("endNet"); value = money(last?.cumulativeNetFen ?? 0); note = t("cumulativeNote");
      legend = `<span><i class="legend-dot cumulative-dot"></i>${t("cumulative")}</span>`;
    } else if (state.view === "balance") {
      label = state.locale === "zh-CN" ? `${monthName(last.key)}结余` : `${monthName(last.key)} net`;
      value = money(last.netFen); note = t("balanceNote");
      legend = `<span><i class="legend-dot balance-dot"></i>${t("net")}</span>`;
    }
    $("metric-label").textContent = label;
    $("metric-value").textContent = value;
    $("metric-value").className = `trend-value${(state.view === "balance" && last.netFen < 0) || (state.view === "cumulative" && last.cumulativeNetFen < 0) ? " negative" : ""}`;
    $("chart-explanation").textContent = note;
    $("chart-legend").innerHTML = legend;
    $("chart-hint").textContent = t(state.view === "cashflow" && state.range === "month" ? "pickDay" : "pickMonth");
    $("chart-footer").textContent = state.view === "cashflow" ? `${t(state.member === "all" ? "household" : state.member)} · ${t({ all: "allLedgers", daily: "dailyLedger", travel: "travelLedger" }[state.ledger])}` : t(state.view === "cumulative" ? "cumulativeFooter" : "balanceFooter");
    $("empty-note").hidden = data.summary.transactionCount !== 0;
    $("empty-note").textContent = t("noRecords");
    const picker = $("chart-picker");
    picker.max = String(Math.max(0, data.points.length - 1));
    picker.value = String(Math.max(0, data.points.findIndex((point) => point.key === state.selected)));
    $("chart-summary").textContent = data.points.map((point) => `${point.key}: ${t(state.view)} ${money(state.view === "cumulative" ? point.cumulativeNetFen : point.netFen)}`).join("; ");
    drawChart(data);
    renderDetail(data);
    renderCategories(data);
  }

  function svgNode(tag, attrs, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function niceStep(value) {
    const power = 10 ** Math.floor(Math.log10(value));
    return [1, 2, 2.5, 5, 10].find((step) => step * power >= value) * power;
  }

  function drawChart(data) {
    const svg = $("trend-svg");
    const width = Math.max(220, $("plot-wrap").clientWidth);
    const height = $("plot-wrap").clientHeight || 238;
    const left = width < 330 ? 42 : 52;
    const right = 16, top = 14, bottom = 32;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const values = data.points.flatMap((point) => state.view === "cashflow" ? [point.incomeFen, point.expenseFen] : [state.view === "cumulative" ? point.cumulativeNetFen : point.netFen]);
    const low = Math.min(0, ...values), high = Math.max(0, ...values);
    const step = niceStep(Math.max(10000, high - low) / 3);
    const min = Math.floor(low / step) * step;
    const max = Math.max(min + step, Math.ceil(high / step) * step);
    const x = (index) => left + plotWidth * (index + 0.5) / data.points.length;
    const y = (value) => top + (max - value) / (max - min) * plotHeight;
    const compact = new Intl.NumberFormat(state.locale, { notation: "compact", maximumFractionDigits: 1 });
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    for (let value = min; value <= max + step / 2; value += step) {
      svg.append(svgNode("line", { x1: left, x2: width - right, y1: y(value), y2: y(value), class: value === 0 ? "zero-line" : "grid-line" }));
      svg.append(svgNode("text", { x: left - 9, y: y(value) + 4, "text-anchor": "end", class: "axis-label" }, compact.format(value / 100)));
    }
    const tickCount = Math.min(width < 400 ? 4 : 6, data.points.length);
    const ticks = new Set(Array.from({ length: tickCount }, (_, i) => tickCount === 1 ? 0 : Math.round(i * (data.points.length - 1) / (tickCount - 1))));
    ticks.forEach((index) => {
      const point = data.points[index];
      const label = point.key.length === 10 ? state.locale === "zh-CN" ? `${Number(point.key.slice(-2))}日` : dateName(point.key) : state.range === "all" ? state.locale === "zh-CN" ? `${point.key.slice(2, 4)}/${Number(point.key.slice(-2))}` : monthName(point.key, true) : monthName(point.key);
      svg.append(svgNode("text", { x: x(index), y: height - 8, "text-anchor": "middle", class: `axis-label${state.selected === point.key ? " selected" : ""}` }, label));
    });
    const series = state.view === "cashflow" ? [["incomeFen", "series-income"], ["expenseFen", "series-expense"]] : state.view === "cumulative" ? [["cumulativeNetFen", "series-cumulative"]] : [["netFen", "series-balance"]];
    series.forEach(([key, className]) => {
      svg.append(svgNode("path", { d: data.points.map((point, index) => `${index ? "L" : "M"}${x(index)} ${y(point[key])}`).join(" "), class: className }));
      data.points.forEach((point, index) => svg.append(svgNode("circle", { cx: x(index), cy: y(point[key]), r: data.points.length === 1 ? 4 : 2.5, class: `${className} series-point` })));
    });
    const selectedIndex = data.points.findIndex((point) => point.key === state.selected);
    if (selectedIndex >= 0) {
      const selected = data.points[selectedIndex];
      svg.append(svgNode("line", { x1: x(selectedIndex), x2: x(selectedIndex), y1: top, y2: height - bottom, class: "selection-line" }));
      series.forEach(([key, className]) => svg.append(svgNode("circle", { cx: x(selectedIndex), cy: y(selected[key]), r: 5, class: `selected-dot ${className}` })));
    }
    const padding = data.points.length > 1 ? plotWidth / data.points.length / 2 : 0;
    Object.assign($("chart-picker").style, { left: `${left + padding}px`, right: `${right + padding}px`, top: `${top}px`, bottom: `${bottom}px`, width: `${plotWidth - padding * 2}px`, height: `${plotHeight}px` });
    const current = data.points[Math.max(0, selectedIndex)];
    $("chart-picker").setAttribute("aria-valuetext", current ? `${current.key}, ${state.view === "cashflow" ? `${t("income")} ${money(current.incomeFen)}, ${t("expense")} ${money(current.expenseFen)}` : `${t(state.view)} ${money(state.view === "cumulative" ? current.cumulativeNetFen : current.netFen)}`}` : "");
  }

  function renderDetail(data) {
    const point = data.points.find((item) => item.key === state.selected);
    $("point-detail").hidden = !point;
    if (!point) return;
    const daily = point.key.length === 10;
    $("point-title").textContent = daily ? dateName(point.key, true) : monthName(point.key, true);
    $("point-count").textContent = countLabel(point.transactionCount);
    $("point-dates").textContent = dateRange(point.from, point.to);
    const fields = [[t("income"), money(point.incomeFen), "income"], [t("expense"), money(point.expenseFen), ""], [t(daily ? "dayNet" : "currentNet"), money(point.netFen), `${point.netFen < 0 ? "negative " : ""}${state.view === "balance" ? "emphasis" : ""}`]];
    if (state.view === "cumulative") fields.push([t("cumulative"), money(point.cumulativeNetFen), "emphasis"]);
    $("point-values").innerHTML = fields.map(([label, value, className]) => `<div class="detail-stat ${className}"><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("");
    $("records-open").hidden = point.transactionCount === 0;
    $("records-open").querySelector("span").textContent = t(daily ? "viewDayRecords" : "viewMonthRecords");
  }

  function renderCategories(data) {
    const groups = new Map();
    data.rows.filter((row) => row.type === "expense" && row.date >= data.range.from && row.date <= data.range.to).forEach((row) => groups.set(row.category, (groups.get(row.category) ?? 0) + row.amountFen));
    const categories = [...groups.entries()].sort((a, b) => b[1] - a[1]);
    const colors = ["#c64d3b", "#e99375", "#cbb29a", "#adbaa1", "#d7c99d", "#a1b7b7", "#c4c1bc"];
    const svg = $("category-svg");
    svg.replaceChildren(svgNode("circle", { cx: 100, cy: 100, r: 70, stroke: "#eeece9", "stroke-width": 15, fill: "none" }));
    const circumference = 2 * Math.PI * 70;
    let offset = 0;
    categories.forEach(([, fen], index) => {
      const length = fen / data.summary.expenseFen * circumference;
      svg.append(svgNode("circle", { cx: 100, cy: 100, r: 70, fill: "none", stroke: colors[index], "stroke-width": 15, "stroke-dasharray": `${Math.max(0, length - 3)} ${circumference - Math.max(0, length - 3)}`, "stroke-dashoffset": -offset, transform: "rotate(-90 100 100)" }));
      offset += length;
    });
    $("category-total").textContent = new Intl.NumberFormat(state.locale, { notation: "compact", maximumFractionDigits: 1 }).format(data.summary.expenseFen / 100);
    $("category-list").innerHTML = categories.map(([key, fen], index) => `<li class="category-item"><span class="category-label"><i class="category-swatch" style="background:${colors[index]}"></i>${escape(t(key))}</span><span class="category-amount">${number(fen)}</span><span class="category-share">${Math.round(fen / data.summary.expenseFen * 100)}%</span></li>`).join("");
    $("category-empty").hidden = categories.length !== 0;
  }

  function selectPoint(index) {
    const data = model();
    const safeIndex = Math.max(0, Math.min(data.points.length - 1, index));
    state.selected = data.points[safeIndex]?.key ?? null;
    $("chart-picker").value = String(safeIndex);
    drawChart(data);
    renderDetail(data);
  }

  function openRecords() {
    const data = model();
    const point = data.points.find((item) => item.key === state.selected);
    if (!point?.transactionCount) return;
    $("records-title").textContent = dateRange(point.from, point.to, true);
    $("record-list").innerHTML = data.rows.filter((row) => row.date >= point.from && row.date <= point.to).map((row) => `<li class="record-row"><div class="record-copy"><p class="record-note">${escape(t(row.category))}</p><p class="record-meta">${escape(dateName(row.date))} · ${escape(t(row.member))} · ${escape(t(row.ledger === "daily" ? "dailyLedger" : "travelLedger"))}</p></div><span class="record-amount ${row.type}">${money(row.type === "income" ? row.amountFen : -row.amountFen, true)}</span></li>`).join("");
    $("records-dialog").showModal();
  }

  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => { state.view = button.dataset.view; state.selected = null; render(); }));
  for (const key of ["range", "scenario", "member", "ledger"]) $(key + "-select").addEventListener("change", (event) => { state[key] = event.target.value; state.selected = null; render(); });
  document.querySelectorAll("button[data-device]").forEach((button) => button.addEventListener("click", () => {
    document.body.dataset.device = button.dataset.device;
    document.querySelectorAll("button[data-device]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  }));
  $("locale-button").addEventListener("click", () => { state.locale = state.locale === "zh-CN" ? "en" : "zh-CN"; render(); });
  $("chart-picker").addEventListener("input", (event) => selectPoint(Number(event.target.value)));
  $("chart-picker").addEventListener("pointerdown", (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    selectPoint(Math.round((event.clientX - box.left) / Math.max(1, box.width) * (model().points.length - 1)));
  });
  $("chart-picker").addEventListener("keydown", (event) => {
    const points = model().points;
    const current = Math.max(0, points.findIndex((point) => point.key === state.selected));
    const next = event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : ["ArrowLeft", "ArrowDown"].includes(event.key) ? current - 1 : ["ArrowRight", "ArrowUp"].includes(event.key) ? current + 1 : null;
    if (next !== null) { event.preventDefault(); selectPoint(next); }
  });
  $("records-open").addEventListener("click", openRecords);
  $("dialog-close").addEventListener("click", () => $("records-dialog").close());
  $("records-dialog").addEventListener("click", (event) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.currentTarget.close();
  });
  new ResizeObserver(() => drawChart(model())).observe($("plot-wrap"));
  render();
})();
