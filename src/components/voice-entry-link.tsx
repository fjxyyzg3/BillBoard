"use client";

import Link from "next/link";
import { useEffect, useRef, type ComponentProps } from "react";
import { useVoiceAccounting } from "@/components/voice-accounting-provider";
import { createVoicePress } from "@/lib/voice/press";

export function VoiceEntryLink({ children, onClick, className, ...props }: ComponentProps<typeof Link>) {
  const voice = useVoiceAccounting();
  const latest = useRef(voice);
  useEffect(() => { latest.current = voice; }, [voice]);
  const suppressClick = useRef(false);
  const held = useRef(false);
  const routeRef = useRef("");
  const linkRef = useRef<HTMLAnchorElement>(null);
  const pressRef = useRef<ReturnType<typeof createVoicePress> | null>(null);
  useEffect(() => {
    const press = createVoicePress({ onLongPress: () => {
      if (document.hidden || routeRef.current !== window.location.pathname + window.location.search) { press.cancel(); held.current = false; return; }
      suppressClick.current = true;
      linkRef.current?.setAttribute("data-voice-consumed", "true");
      latest.current.begin();
    }, onCancelChange: (armed) => latest.current.armCancel(armed) });
    pressRef.current = press;
    const interrupt = () => {
      if (held.current) { held.current = false; press.cancel(); suppressClick.current = true; latest.current.cancel(); }
    };
    const visibility = () => { if (document.hidden) interrupt(); };
    window.addEventListener("blur", interrupt);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", interrupt);
      document.removeEventListener("visibilitychange", visibility);
      interrupt();
      press.cancel(); pressRef.current = null;
    };
  }, []);

  // Keep iOS link previews from taking over the recording gesture.
  return <Link {...props} ref={linkRef} aria-keyshortcuts="Space" className={`${className ?? ""} touch-none select-none [-webkit-touch-callout:none]`} title={voice.hint}
    onContextMenu={(event) => event.preventDefault()}
    onDragStart={(event) => event.preventDefault()}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      routeRef.current = window.location.pathname + window.location.search;
      suppressClick.current = false;
      linkRef.current?.removeAttribute("data-voice-consumed");
      if (pressRef.current?.begin(event.pointerId, event.clientY)) { held.current = true; event.currentTarget.setPointerCapture(event.pointerId); }
    }}
    onPointerMove={(event) => pressRef.current?.move(event.pointerId, event.clientY)}
    onPointerUp={(event) => {
      const outcome = pressRef.current?.end(event.pointerId);
      if (outcome !== "ignored") held.current = false;
      if (outcome === "submit") latest.current.finish();
      else if (outcome === "cancel") latest.current.cancel();
      if (outcome === "submit" || outcome === "cancel") { suppressClick.current = true; event.preventDefault(); }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { held.current = false; pressRef.current?.cancel(); suppressClick.current = true; latest.current.cancel(); }}
    onLostPointerCapture={() => {
      if (held.current) { held.current = false; pressRef.current?.cancel(); suppressClick.current = true; latest.current.cancel(); }
    }}
    onKeyDown={(event) => {
      if (event.key === " " && !event.repeat) { event.preventDefault(); suppressClick.current = false; latest.current.begin(); }
    }}
    onClick={(event) => {
      if (suppressClick.current) { event.preventDefault(); suppressClick.current = false; linkRef.current?.removeAttribute("data-voice-consumed"); return; }
      onClick?.(event);
    }}>{children}</Link>;
}
