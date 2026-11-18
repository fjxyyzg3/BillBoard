"use client";

import type { ComponentProps } from "react";
import { appendEncryption } from "@/lib/encryption/client";

export function EncryptedForm({ action, ...props }: Omit<ComponentProps<"form">, "action"> & { action: (data: FormData) => Promise<void> }) {
  return <form {...props} action={async (data) => { await action(appendEncryption(data)); }} />;
}
