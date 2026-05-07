"use server";

import { ImportRowDecision } from "@prisma/client";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { redirect } from "next/navigation";

import { requireAppSession } from "@/lib/auth/session";
import {
  confirmImportDraft,
  createSuiShouJiImportDraft,
  createWechatPayImportDraft,
  saveImportDraftMappings,
  saveWechatPayDraftOwnerMember,
  setImportDraftRowDecision,
} from "@/lib/imports/drafts";
import { SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE, type ImportSource } from "@/lib/imports/types";

const unrecognizedSuiShouJiWorkbookMessage = "无法识别随手记导出格式";
const unrecognizedWechatPayWorkbookMessage = "无法识别微信支付账单格式";
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

function readImportSource(formData: FormData): ImportSource | null {
  const source = String(formData.get("source") ?? "").trim();

  if (source === SUI_SHOU_JI_SOURCE || source === WECHAT_PAY_SOURCE) {
    return source;
  }

  return null;
}

export async function uploadImportDraft(formData: FormData) {
  const source = readImportSource(formData);

  if (!source) {
    redirect("/records/import?error=missing-source");
  }

  const file = formData.get("file");

  if (!isXlsxFile(file)) {
    redirect("/records/import?error=unsupported-file");
  }

  if (file.size > maxUploadFileBytes) {
    redirect("/records/import?error=file-too-large");
  }

  try {
    const sessionUser = await requireAppSession();
    const input = {
      buffer: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      sessionUser,
    };
    const draft =
      source === WECHAT_PAY_SOURCE
        ? await createWechatPayImportDraft(input)
        : await createSuiShouJiImportDraft(input);

    redirectToDraft(draft.id);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }

    if (error instanceof Error && error.message === unrecognizedSuiShouJiWorkbookMessage) {
      redirect("/records/import?error=unrecognized-file");
    }

    if (error instanceof Error && error.message === unrecognizedWechatPayWorkbookMessage) {
      redirect("/records/import?error=unrecognized-wechat-pay-file");
    }

    if (error instanceof Error && error.message === importFileTooLargeMessage) {
      redirect("/records/import?error=file-too-large");
    }

    redirect("/records/import?error=upload-failed");
  }
}

export async function uploadSuiShouJiImportDraft(formData: FormData) {
  const source = String(formData.get("source") ?? "").trim();

  if (source) {
    return uploadImportDraft(formData);
  }

  const compatibleFormData = new FormData();
  for (const [key, value] of formData.entries()) {
    compatibleFormData.append(key, value);
  }
  compatibleFormData.set("source", SUI_SHOU_JI_SOURCE);

  return uploadImportDraft(compatibleFormData);
}

export async function saveWechatPayOwnerMember(formData: FormData) {
  const draftId = readDraftId(formData);
  const ownerMemberId = String(formData.get("ownerMemberId") ?? "").trim();

  if (!ownerMemberId) {
    redirectToDraft(draftId);
  }

  const sessionUser = await requireAppSession();

  await saveWechatPayDraftOwnerMember(draftId, ownerMemberId, sessionUser);

  redirectToDraft(draftId);
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
