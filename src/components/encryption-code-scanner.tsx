"use client";

import { useEffect, useRef, useState } from "react";
import { getEncryptionMessages, type Locale } from "@/lib/i18n";

type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
type DetectorClass = new (options: { formats: string[] }) => Detector;

export function EncryptionCodeScanner({ locale, onCode }: { locale: Locale; onCode: (value: string) => void }) {
  const labels = getEncryptionMessages(locale);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const [active, setActive] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  function stop() {
    generation.current += 1;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setActive(false);
  }

  useEffect(() => {
    const stopOnHide = () => { if (document.hidden) stop(); };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stopOnHide);
    return () => { window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stopOnHide); generation.current += 1; stream.current?.getTracks().forEach((track) => track.stop()); };
  }, []);

  async function scan() {
    const Barcode = (window as Window & { BarcodeDetector?: DetectorClass }).BarcodeDetector;
    if (!Barcode || !navigator.mediaDevices?.getUserMedia) { setUnavailable(true); return; }
    stop();
    const expected = generation.current;
    try {
      const captured = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (expected !== generation.current) { captured.getTracks().forEach((track) => track.stop()); return; }
      stream.current = captured;
      if (!video.current) throw new Error("CAMERA_UNAVAILABLE");
      video.current.srcObject = captured;
      await video.current.play();
      setActive(true); setUnavailable(false);
      const detector = new Barcode({ formats: ["qr_code"] });
      const next = async () => {
        if (expected !== generation.current || !video.current) return;
        try {
          const results = await detector.detect(video.current);
          if (expected !== generation.current) return;
          const value = results.find((result) => result.rawValue.startsWith("BBK1."))?.rawValue;
          if (value) { onCode(value); stop(); return; }
          requestAnimationFrame(() => { void next(); });
        } catch { stop(); setUnavailable(true); }
      };
      await next();
    } catch { if (expected === generation.current) { stop(); setUnavailable(true); } }
  }

  return <div className="space-y-2">
    <button className="min-h-11 rounded-xl border border-[var(--bb-line-strong)] px-4 text-sm font-medium" onClick={() => active ? stop() : void scan()} type="button">{active ? labels.stopCamera : labels.scanCode}</button>
    <video aria-hidden="true" className={active ? "max-h-64 w-full rounded-xl" : "hidden"} muted playsInline ref={video} />
    {unavailable ? <p className="text-xs text-[var(--bb-muted)]" role="status">{labels.noCamera}</p> : null}
  </div>;
}
