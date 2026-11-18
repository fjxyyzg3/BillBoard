"use client";

import { LoaderCircle } from "lucide-react";
import { useFormStatus } from "react-dom";
import { getMessages, type Locale } from "@/lib/i18n";
import styles from "./finance-b2.module.css";

export function ImportUploadButton({ locale }: { locale: Locale }) {
  const { pending } = useFormStatus();
  const labels = getMessages(locale).import;
  return <>
    <button
      aria-busy={pending || undefined}
      className={`${styles.primaryButton} inline-flex w-full items-center justify-center gap-2 bg-[var(--bb-primary)] px-4 text-white transition hover:bg-[var(--bb-primary-hover)] disabled:cursor-wait disabled:opacity-60`}
      disabled={pending}
      type="submit"
    >
      {pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" /> : null}
      {pending ? labels.uploading : labels.upload}
    </button>
    <p className="sr-only" role="status">{pending ? labels.uploading : ""}</p>
  </>;
}
