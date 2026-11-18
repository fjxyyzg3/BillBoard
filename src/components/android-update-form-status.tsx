"use client";

import { useFormStatus } from "react-dom";

/** Server action forms expose their real pending state to the APK installation guard. */
export function AndroidUpdateFormStatus() {
  const { pending } = useFormStatus();
  return <span data-apk-update-blocked={pending || undefined} hidden />;
}
