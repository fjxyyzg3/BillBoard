"use client";

import { ArrowUpRight, Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { getMessages, type Locale } from "@/lib/i18n";
import { HelpEntryScene, HelpImportScene, HelpReportsScene, HelpSecurityScene } from "@/components/help-showcase-scenes";
import styles from "@/components/help-showcase.module.css";

const stepDuration = 3200;
const motionQuery = "(prefers-reduced-motion: reduce)";
const serverReducedMotion = () => true;
const serverVisibility = () => false;
const getReducedMotion = () => window.matchMedia(motionQuery).matches;
const getPageVisibility = () => document.visibilityState === "visible";

function subscribeMotion(callback: () => void) {
  const query = window.matchMedia(motionQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

type SceneKind = "security" | "entry" | "import" | "reports";

function SceneFrame({ kind, locale, guide, Scene }: {
  kind: SceneKind;
  locale: Locale;
  guide: string;
  Scene: ComponentType<{ step: number; locale: Locale }>;
}) {
  const labels = getMessages(locale).help.showcase;
  const copy = labels[kind];
  const reducedMotion = useSyncExternalStore(subscribeMotion, getReducedMotion, serverReducedMotion);
  const pageVisible = useSyncExternalStore(subscribeVisibility, getPageVisibility, serverVisibility);
  const frame = useRef<HTMLElement>(null);
  const [started, setStarted] = useState(false);
  const [inView, setInView] = useState(false);
  const [step, setStep] = useState(3);
  const [paused, setPaused] = useState(false);
  const [complete, setComplete] = useState(false);
  const [replay, setReplay] = useState(0);
  const playing = inView && pageVisible && !reducedMotion && !paused && !complete;
  const visibleStep = reducedMotion ? 3 : step;
  const titleId = `feature-${kind}-title`;

  useEffect(() => {
    const node = frame.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      const visible = entry.isIntersecting && entry.intersectionRatio >= 0.2;
      setInView(visible);
      if (visible && !reducedMotion && !started) {
        setStarted(true);
        setStep(0);
      }
    }, { threshold: [0, 0.2] });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reducedMotion, started]);

  useEffect(() => {
    if (!playing) return;
    const timeout = window.setTimeout(() => {
      if (step === 3) setComplete(true);
      else setStep(step + 1);
    }, stepDuration);
    return () => window.clearTimeout(timeout);
  }, [playing, step, replay]);

  function restart() {
    setStarted(true);
    setStep(0);
    setPaused(false);
    setComplete(false);
    setReplay((value) => value + 1);
  }

  return <section aria-labelledby={titleId} className={`${styles.section} ${styles[kind]}`} id={`feature-${kind}`}>
    <header className={styles.sectionHeading}>
      <h2 className={styles.title} id={titleId}>{copy.title}</h2>
      <p className={styles.description}>{copy.description}</p>
    </header>
    <div className={styles.body}>
      <figure className={styles.stage} data-demo-playing={playing} data-demo-started={started && !reducedMotion} data-demo-step={visibleStep} data-reduced-motion={reducedMotion} ref={frame}>
        <Scene key={replay} locale={locale} step={visibleStep} />
        <figcaption className={styles.footer}>
          <div className={styles.caption}>
            <p>{labels.demo}</p>
            <p className={styles.steps}>
              <span className={styles.currentStep}>{reducedMotion ? labels.reduced : copy.steps[visibleStep]}</span>
            </p>
          </div>
          <div className={styles.controls}>
            <button className={styles.controlButton} disabled={reducedMotion || complete} onClick={() => setPaused((value) => !value)} type="button">
              {paused ? <Play aria-hidden="true" size={16} /> : <Pause aria-hidden="true" size={16} />}
              {complete ? labels.complete : paused ? labels.resume : labels.pause}
            </button>
            <button className={styles.controlButton} disabled={reducedMotion} onClick={restart} type="button">
              <RotateCcw aria-hidden="true" size={16} />{labels.replay}
            </button>
          </div>
        </figcaption>
      </figure>
    </div>
    <p className={styles.details}>{copy.detail}</p>
    <a className={styles.guideLink} href={`#${guide}`}>{labels.readGuide}<ArrowUpRight aria-hidden="true" size={16} /></a>
  </section>;
}

export function HelpShowcase({ locale }: { locale: Locale }) {
  return <div className={styles.showcase} id="features">
    <SceneFrame Scene={HelpSecurityScene} guide="encryption" kind="security" locale={locale} />
    <SceneFrame Scene={HelpEntryScene} guide="recording" kind="entry" locale={locale} />
    <SceneFrame Scene={HelpImportScene} guide="import-export" kind="import" locale={locale} />
    <SceneFrame Scene={HelpReportsScene} guide="reports" kind="reports" locale={locale} />
  </div>;
}
