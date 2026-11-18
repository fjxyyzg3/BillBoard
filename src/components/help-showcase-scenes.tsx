"use client";

import { ArrowRight, Check, ChevronRight, FileSpreadsheet, KeyRound, LockKeyhole, Mic, ShieldCheck, TextCursorInput } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { getMessages, type Locale } from "@/lib/i18n";
import styles from "@/components/help-showcase.module.css";

type SceneProps = { step: number; locale: Locale };

const sampleEntries = [
  { id: "lunch", category: "dining", amountFen: 3500, type: "expense" },
  { id: "metro", category: "transport", amountFen: 600, type: "expense" },
  { id: "salary", category: "salaryCategory", amountFen: 800000, type: "income" },
] as const;

const reportRows = [
  { day: 2, category: "dining", currentFen: 2800, previousFen: 3000 },
  { day: 4, category: "home", currentFen: 12000, previousFen: 11000 },
  { day: 6, category: "transport", currentFen: 2400, previousFen: 2400 },
  { day: 10, category: "dining", currentFen: 6800, previousFen: 6400 },
  { day: 12, category: "shopping", currentFen: 18000, previousFen: 16000 },
  { day: 18, category: "dining", currentFen: sampleEntries[0].amountFen, previousFen: 3000, note: "lunch" },
  { day: 18, category: "transport", currentFen: sampleEntries[1].amountFen, previousFen: 600, note: "metro" },
  { day: 24, category: "dining", currentFen: 8500, previousFen: 6200 },
] as const;

const waveformHeights = [14, 22, 36, 25, 49, 64, 38, 71, 51, 82, 58, 94, 66, 42, 76, 50, 62, 35, 46, 27, 38, 20, 14];

function money(amountFen: number, locale: Locale) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "CNY", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2 }).format(amountFen / 100);
}

export function HelpSecurityScene({ step, locale }: SceneProps) {
  const labels = getMessages(locale).help.showcase.security;
  const encrypted = step > 0;
  const locked = step === 1 || step === 2;

  return <div className={styles.securityScene} data-ui="household-security">
    <div className={styles.sceneTopline}>
      <span className={styles.sceneBrand}>{getMessages(locale).app.brand}</span>
      <span>{labels.family}</span>
    </div>
    <div className={styles.securityGrid}>
      <div className={styles.membersPanel}>
        <p className={styles.panelTitle}>{labels.members}</p>
        <div className={styles.memberRows}>
          {[{ name: labels.memberOne, role: labels.owner }, { name: labels.memberTwo, role: labels.member }].map((person, index) => <div className={styles.memberRow} key={person.name}>
            <span aria-hidden="true" className={`${styles.avatar} ${index === 0 ? styles.avatarOwner : styles.avatarMember}`}>{person.name.slice(0, 1)}</span>
            <div><span className={styles.memberName}>{person.name}</span><span className={styles.smallLabel}>{person.role}</span></div>
            <Check aria-hidden="true" className={styles.memberCheck} size={18} />
          </div>)}
        </div>
        <p className={styles.accessNote}><ShieldCheck aria-hidden="true" size={17} />{labels.access}</p>
        <div className={styles.accessBoundary}>
          <LockKeyhole aria-hidden="true" size={18} />
          <div><p>{labels.separate}</p><span className={styles.smallLabel}>{labels.separateDetail}</span></div>
        </div>
        <p className={styles.boundaryCaption}>{labels.privacy}</p>
      </div>
      <div className={styles.vaultPanel}>
        <div className={styles.settingRow}>
          <div><p className={styles.panelTitle}>{labels.settings}</p><p className={styles.smallLabel}>{labels.optional}</p></div>
          <div className={styles.settingState}><span>{encrypted ? labels.enabled : labels.disabled}</span><span aria-hidden="true" className={styles.switch} data-on={encrypted}><span /></span></div>
        </div>
        <p className={styles.backupNote} data-ready={encrypted}>{encrypted ? <Check aria-hidden="true" size={15} /> : <KeyRound aria-hidden="true" size={15} />}{encrypted ? labels.verified : labels.beforeEnable}</p>
        <div className={styles.codePanel} data-active={step >= 2}>
          <span className={styles.smallLabel}>{labels.code}</span>
          <div className={styles.codeField}><KeyRound aria-hidden="true" size={18} /><span className={step >= 2 ? styles.codeValue : styles.codePlaceholder}>{step >= 2 ? labels.maskedCode : labels.codePlaceholder}</span><Check aria-hidden="true" className={styles.codeCheck} data-visible={step === 3} size={18} /></div>
        </div>
        <div className={styles.secureRecord} data-locked={locked}>
          <div className={styles.recordHeading}><span>{labels.ledger}</span><span className={styles.smallLabel}>{labels.example}</span></div>
          <div className={styles.protectedRow}>
            <div><p>{locked ? labels.encrypted : labels.lunch}</p><span className={styles.smallLabel}>{locked ? labels.maskedCode : `${labels.dining} · ${labels.memberOne}`}</span></div>
            <strong className={styles.recordAmount}>{locked ? <LockKeyhole aria-hidden="true" size={22} /> : money(sampleEntries[0].amountFen, locale)}</strong>
          </div>
          <p className={styles.unlockStatus} data-unlocked={step === 3}>{step === 3 ? <Check aria-hidden="true" size={16} /> : <LockKeyhole aria-hidden="true" size={16} />}{step === 0 ? labels.access : step === 1 ? labels.locked : step === 2 ? labels.unlocking : labels.unlocked}</p>
        </div>
      </div>
    </div>
  </div>;
}

export function HelpEntryScene({ step, locale }: SceneProps) {
  const labels = getMessages(locale).help.showcase.entry;
  const [mode, setMode] = useState<"voice" | "text">("voice");
  const expenseFen = sampleEntries.filter((row) => row.type === "expense").reduce((sum, row) => sum + row.amountFen, 0);
  const incomeFen = sampleEntries.filter((row) => row.type === "income").reduce((sum, row) => sum + row.amountFen, 0);

  return <div className={styles.entryScene} data-ui="natural-language-entry">
    <div className={styles.composer}>
      <div className={styles.composerHeader}><span className={styles.sceneBrand}>{getMessages(locale).app.brand}</span><span className={styles.panelTitle}>{labels.titleInput}</span></div>
      <div aria-label={labels.modes} className={`${styles.modeSwitch} bb-segmented bb-segmented--spaced`} role="group">
        <button aria-pressed={mode === "voice"} onClick={() => setMode("voice")} type="button"><Mic aria-hidden="true" size={17} />{labels.voice}</button>
        <button aria-pressed={mode === "text"} onClick={() => setMode("text")} type="button"><TextCursorInput aria-hidden="true" size={17} />{labels.text}</button>
      </div>
      <div className={styles.inputCanvas} data-mode={mode}>
        {mode === "voice" ? <>
          <div aria-hidden="true" className={styles.waveform} data-recording={step === 0}>
            {waveformHeights.map((height, index) => <span key={index} style={{ height, animationDelay: `${index * -0.08}s` }} />)}
          </div>
          <p className={styles.inputHint}>{step === 0 ? labels.listening : labels.transcript}</p>
        </> : <div className={styles.textInputHint}><TextCursorInput aria-hidden="true" size={23} /><span>{labels.typed}</span></div>}
        <p className={styles.exampleText} data-parsed={step >= 1}>{labels.phrases.map((phrase) => <span key={phrase}>{phrase}</span>)}{mode === "text" && step === 0 ? <span aria-hidden="true" className={styles.textCaret} /> : null}</p>
      </div>
      <div className={styles.entryContext}><div><span className={styles.smallLabel}>{labels.target}</span><span>{labels.ledger}</span></div><div><span className={styles.smallLabel}>{labels.memberLabel}</span><span>{labels.member}</span></div></div>
    </div>
    <div aria-hidden="true" className={styles.entryFlow}><ChevronRight size={25} /><span className={styles.flowDot} data-active={step === 1} /></div>
    <div className={styles.entryResults}>
      <div className={styles.resultHeader}><div><p className={styles.panelTitle}>{labels.result}</p><span className={styles.smallLabel}>{labels.date}</span></div><span className={styles.resultStatus} data-saved={step >= 2}>{step >= 2 ? <Check aria-hidden="true" size={15} /> : null}{step === 0 ? labels.waiting : step === 1 ? labels.processing : labels.saved}</span></div>
      <div className={styles.transactionRows}>
        {step < 2 ? <div className={styles.resultPending}><ChevronRight aria-hidden="true" size={24} /><p>{labels.pending}</p></div> : null}
        {sampleEntries.map((row, index) => <div aria-hidden={step < 2} className={styles.transactionRow} data-visible={step >= 2} key={row.id} style={{ "--row-delay": `${index * 90}ms` } as CSSProperties}>
          <div className={styles.transactionIdentity}><p>{labels[row.id]}</p><span className={styles.smallLabel}>{labels[row.category]} · {labels.member}</span></div>
          <strong className={`${styles.transactionAmount} ${row.type === "income" ? styles.income : ""}`}>{row.type === "income" ? "+" : "−"}{money(row.amountFen, locale)}</strong>
        </div>)}
      </div>
      <div aria-hidden={step < 2} className={styles.entryTotals} data-visible={step >= 2}><div><span className={styles.smallLabel}>{labels.expense}</span><strong>{money(expenseFen, locale)}</strong></div><div><span className={styles.smallLabel}>{labels.income}</span><strong className={styles.income}>{money(incomeFen, locale)}</strong></div></div>
    </div>
  </div>;
}

export function HelpImportScene({ step, locale }: SceneProps) {
  const labels = getMessages(locale).help.showcase.import;
  const rows = sampleEntries.filter((row) => row.type === "expense");
  const totalFen = rows.reduce((sum, row) => sum + row.amountFen, 0);
  const sources = [
    { id: "suiShouJi", format: ".xlsx" },
    { id: "wechatPay", format: ".xlsx" },
    { id: "alipay", format: ".csv" },
    { id: "cmb", format: ".pdf / .zip" },
  ] as const;

  return <div className={styles.importScene} data-ui="statement-import">
    <ul aria-label={labels.supported} className={styles.importSources}>
      {sources.map((source) => <li data-selected={source.id === "wechatPay"} key={source.id}><span>{labels.sources[source.id]}</span><span>{source.format}</span></li>)}
    </ul>
    <p className={styles.importSourceNote}>{labels.zipNote}</p>
    <div className={styles.importGrid}>
      <div className={styles.importSetup}>
        <div className={styles.importFile}>
          <FileSpreadsheet aria-hidden="true" size={28} />
          <div><p>{labels.file}</p><span className={styles.smallLabel}>{step === 0 ? labels.upload : labels.uploaded}</span></div>
          {step > 0 ? <Check aria-hidden="true" className={styles.importCheck} size={19} /> : null}
        </div>
        <div className={styles.importContext}><div><span className={styles.smallLabel}>{labels.target}</span><span>{labels.ledger}</span></div><div><span className={styles.smallLabel}>{labels.memberLabel}</span><span>{labels.member}</span></div></div>
        <div className={styles.importMappings} data-ready={step >= 1}>
          <p className={styles.panelTitle}>{labels.mappings}</p>
          {rows.map((row) => <div className={styles.importMapping} key={row.id}><span>{row.id === "lunch" ? labels.originalDining : labels.originalTransport}</span><ArrowRight aria-hidden="true" size={16} /><span>{step >= 1 ? labels[row.category] : labels.pendingMapping}</span></div>)}
          <p className={styles.importReuse}><Check aria-hidden="true" size={15} />{labels.reuse}</p>
        </div>
      </div>
      <div className={styles.importReview}>
        <div className={styles.importReviewHeading}><p className={styles.panelTitle}>{labels.review}</p><span className={styles.importStatus} data-saved={step === 3}>{step === 3 ? <Check aria-hidden="true" size={15} /> : null}{step === 3 ? labels.saved : labels.ready}</span></div>
        <div className={styles.importRecords}>
          {step < 2 ? <p className={styles.importPending}><ChevronRight aria-hidden="true" size={24} />{labels.pendingReview}</p> : <>
            {rows.map((row, index) => <div className={styles.importRecord} key={row.id} style={{ "--row-delay": `${index * 90}ms` } as CSSProperties}><div><p>{labels[row.id]}</p><span className={styles.smallLabel}>{labels[row.category]} · {labels.member}</span></div><strong>−{money(row.amountFen, locale)}</strong></div>)}
            <div className={`${styles.importRecord} ${styles.importDuplicate}`}><div><p>{labels.duplicateLunch}</p><span className={styles.smallLabel}>{labels.duplicate}</span></div><span className={styles.importExcludedAmount}>−{money(sampleEntries[0].amountFen, locale)}</span></div>
          </>}
        </div>
        <div aria-hidden={step < 2} className={styles.importTotal} data-visible={step >= 2}><span>{labels.total}</span><strong>{money(totalFen, locale)}</strong></div>
      </div>
    </div>
  </div>;
}

export function HelpReportsScene({ step, locale }: SceneProps) {
  const labels = getMessages(locale).help.showcase.reports;
  const previous = step === 0;
  const amountKey = previous ? "previousFen" : "currentFen";
  const days = previous ? 30 : 31;
  const offset = previous ? 1 : 3;
  const totalFen = reportRows.reduce((sum, row) => sum + row[amountKey], 0);
  const dailyFen = Array.from({ length: days }, (_, index) => reportRows.filter((row) => row.day === index + 1).reduce((sum, row) => sum + row[amountKey], 0));
  const categoryTotals = (["dining", "shopping", "home", "transport"] as const).map((category) => ({ category, amountFen: reportRows.filter((row) => row.category === category).reduce((sum, row) => sum + row[amountKey], 0) }));
  const selectedRows = reportRows.filter((row) => row.day === 18);
  const selectedTotalFen = selectedRows.reduce((sum, row) => sum + row[amountKey], 0);
  const largestDayFen = Math.max(...dailyFen);
  const cumulative = dailyFen.map((_, index) => dailyFen.slice(0, index + 1).reduce((sum, amount) => sum + amount, 0));
  const line = cumulative.map((amount, index) => `${index === 0 ? "M" : "L"}${(4 + index / (days - 1) * 272).toFixed(2)},${(65 - amount / 60000 * 60).toFixed(2)}`).join(" ");

  return <div className={styles.reportScene} data-ui="household-reports">
    <div className={styles.reportHeader}><div><span className={styles.sceneBrand}>{getMessages(locale).app.brand}</span><p className={styles.panelTitle}>{labels.household}</p></div><div aria-label={labels.monthLabel} className={styles.monthSelection}><span data-selected={previous}>{labels.previousMonth}</span><ChevronRight aria-hidden="true" size={16} /><span data-selected={!previous}>{labels.currentMonth}</span></div></div>
    <div className={styles.reportGrid}>
      <div className={styles.reportBreakdown}>
        <div className={styles.reportMetric}><span className={styles.smallLabel}>{labels.expense}</span><strong>{money(totalFen, locale)}</strong><span className={styles.smallLabel}>{labels.transactions(reportRows.length)}</span></div>
        <div className={styles.categoryList}><p className={styles.chartTitle}>{labels.categories}</p>{categoryTotals.map((row) => <div className={styles.categoryRow} key={row.category}><div><span>{labels[row.category]}</span><span>{money(row.amountFen, locale)}</span></div><div aria-hidden="true" className={styles.barTrack}><span style={{ transform: `scaleX(${row.amountFen / totalFen})` }} /></div></div>)}</div>
        <div className={styles.trend}><p className={styles.chartTitle}>{labels.cumulative}</p><svg aria-label={labels.cumulative} className={styles.trendChart} preserveAspectRatio="none" role="img" viewBox="0 0 280 72"><title>{labels.cumulative}</title><line stroke="var(--bb-warm-line)" x1="4" x2="276" y1="65" y2="65" /><path className={styles.trendPath} d={line} fill="none" stroke="var(--bb-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg><div className={styles.axisLabels}><span>{labels.firstDay}</span><span>{previous ? labels.lastDayPrevious : labels.lastDayCurrent}</span></div></div>
      </div>
      <div className={styles.calendarPanel}>
        <p className={styles.panelTitle}>{labels.calendar}</p>
        <p className={styles.calendarMonth}>{previous ? labels.previousMonth : labels.currentMonth}</p>
        <div className={styles.calendarGrid}>
          {labels.weekdays.map((day, index) => <span className={styles.weekday} key={`weekday-${index}`}>{day}</span>)}
          {Array.from({ length: offset }, (_, index) => <span aria-hidden="true" key={`offset-${index}`} />)}
          {dailyFen.map((amountFen, index) => <div aria-label={labels.dayAmount(index + 1, money(amountFen, locale))} className={styles.calendarDay} data-selected={index + 1 === 18 && step >= 2} key={index} style={{ backgroundColor: amountFen ? `color-mix(in srgb, var(--bb-primary) ${8 + amountFen / largestDayFen * 23}%, var(--bb-surface))` : undefined }}><span>{index + 1}</span><span className={styles.calendarAmount}>{amountFen ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amountFen / 100) : labels.emptyAmount}</span></div>)}
        </div>
      </div>
      <div className={styles.reportDetails} data-selected={step >= 2}>
        <div className={styles.dayDetailHeading}><p className={styles.panelTitle}>{labels.details}</p><span className={styles.smallLabel}>{labels.selectedDay(selectedRows.length)}</span><strong>{money(selectedTotalFen, locale)}</strong></div>
        <div className={styles.detailRecords} data-open={step === 3}>
          {step < 3 ? <div className={styles.reportPending}><ChevronRight aria-hidden="true" size={22} /><p>{step < 2 ? labels.chooseDay : labels.opening}</p></div> : null}
          {selectedRows.map((row, index) => <div aria-hidden={step < 3} className={styles.detailRecord} key={row.category} style={{ "--row-delay": `${index * 90}ms` } as CSSProperties}><div><p>{labels[row.note]}</p><span className={styles.smallLabel}>{labels[row.category]} · {labels.member}</span></div><strong>−{money(row[amountKey], locale)}</strong></div>)}
        </div>
        <p className={styles.detailLedger}>{labels.ledger}<ChevronRight aria-hidden="true" size={16} /></p>
      </div>
    </div>
  </div>;
}
