"use server";

import { ImportRowDecision } from "@prisma/client";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { redirect } from "next/navigation";

import { requireAppSession } from "@/lib/auth/session";
import {
  confirmImportDraft,
  createSuiShouJiImportDraft,
  saveImportDraftMappings,
  setImportDraftRowDecision,
} from "@/lib/imports/drafts";

const unrecognizedWorkbookMessage = "无法识别随手记导出格式";
const importFileTooLargeMessage = "Import file is too large";
const maxUploadFileBytes = 20 * 1024 * 1024;

function readDraftId(formData: FormData) {
  const draftId = String(formData.get("draftId") ?? "").trim();

  if (!draftId) {
    redirect("/records/import?error=missing-draft");
  }

  return draftId;
}

function redirectToDraft(draftId: string) {
  redirect(`/records/import?draft=${encodeURIComponent(draftId)}`);
}

function isXlsxFile(value: FormDataEntryValue | null): value is File {
  return value instanceof File && value.name.toLowerCase().endsWith(".xlsx");
}

export async function uploadSuiShouJiImportDraft(formData: FormData) {
  const file = formData.get("file");

  if (!isXlsxFile(file)) {
    redirect("/records/import?error=unsupported-file");
  }

  if (file.size > maxUploadFileBytes) {
    redirect("/records/import?error=file-too-large");
  }

  try {
    const sessionUser = await requireAppSession();
    const draft = await createSuiShouJiImportDraft({
      buffer: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      sessionUser,
    });

    redirectToDraft(draft.id);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }

    if (error instanceof Error && error.message === unrecognizedWorkbookMessage) {
      redirect("/records/import?error=unrecognized-file");
    }

    if (error instanceof Error && error.message === importFileTooLargeMessage) {
      redirect("/records/import?error=file-too-large");
    }

    redirect("/records/import?error=upload-failed");
  }
}

export async function saveImportMappings(formData: FormData) {
  const draftId = readDraftId(formData);
  const sessionUser = await requireAppSession();
  const mappings = Array.from(formData.entries()).flatMap(([key, value]) => {
    if (!key.startsWith("mapping:") || typeof value !== "string" || !value) {
      return [];
    }

    return [
      {
        categoryId: value,
        mappingKey: key.slice("mapping:".length),
      },
    ];
  });

  if (mappings.length > 0) {
    await saveImportDraftMappings(draftId, mappings, sessionUser);
  }

  redirectToDraft(draftId);
}

export async function saveImportDecisions(formData: FormData) {
  const draftId = readDraftId(formData);
  const sessionUser = await requireAppSession();

  for (const [key, value] of formData.entries()) {
    if (
      !key.startsWith("decision:") ||
      (value !== ImportRowDecision.KEEP && value !== ImportRowDecision.SKIP)
    ) {
      continue;
    }

    await setImportDraftRowDecision(draftId, key.slice("decision:".length), value, sessionUser);
  }

  redirectToDraft(draftId);
}

export async function confirmImportDraftAction(formData: FormData) {
  const draftId = readDraftId(formData);
  const sessionUser = await requireAppSession();

  await confirmImportDraft(draftId, sessionUser);

  redirect(`/records/import?draft=${encodeURIComponent(draftId)}&completed=1`);
}
