"use server";

import { extractEncryption, withHouseholdEncryption } from "@/lib/encryption/request";
import { EncryptionRequestError, type EncryptionInput } from "@/lib/encryption/types";

import { AppEventType, ImportRowDecision } from "@prisma/client";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { redirect } from "next/navigation";

import { requireAppSession } from "@/lib/auth/session";
import { buildImportReviewHref, getImportReviewNavigation } from "@/lib/imports/review";
import {
  CMB_ZIP_PASSWORD_REQUIRED_MESSAGE,
  CMB_ZIP_UNREADABLE_MESSAGE,
} from "@/lib/imports/sources/cmb-zip";
import {
  confirmImportDraft,
  createAlipayImportDraft,
  createCmbImportDraft,
  createSuiShouJiImportDraft,
  createWechatPayImportDraft,
  saveImportDraftMappings,
  saveImportDraftMemberMappings,
  savePaymentImportDraftOwnerMember,
  setImportDraftRowDecisions,
  getImportDuplicateCandidate,
  type ImportDraftMappingInput,
} from "@/lib/imports/drafts";
import { IGNORE_IMPORT_MAPPING_VALUE } from "@/lib/imports/mapping-form";
import {
  ALIPAY_SOURCE,
  CMB_SOURCE,
  SUI_SHOU_JI_SOURCE,
  WECHAT_PAY_SOURCE,
  type ImportSource,
} from "@/lib/imports/types";
import { IMPORT_FILE_TOO_LARGE_MESSAGE, MAX_IMPORT_FILE_BYTES } from "@/lib/imports/limits";
import { XLSX_BUSY, XLSX_RESOURCE_LIMIT, XLSX_TIMEOUT, XLSX_UNREADABLE } from "@/lib/imports/xlsx";
import { recordAppEvent } from "@/lib/ops/record-event";
import { ResourceBusyError, ResourceExpiredError } from "@/lib/resources/admission";
import { parseEntryContextFormValue } from "@/lib/transactions/entry-context";

const unrecognizedSuiShouJiWorkbookMessage = "无法识别随手记导出格式";
const unrecognizedWechatPayWorkbookMessage = "无法识别微信支付账单格式";
const unrecognizedAlipayCsvMessage = "无法识别支付宝账单格式";
const unrecognizedCmbPdfMessage = "无法识别招商银行流水格式";

function readDraftId(formData: FormData) {
  const draftId = String(formData.get("draftId") ?? "").trim();

  if (!draftId) {
    redirect("/records/import?error=missing-draft");
  }

  return draftId;
}

function redirectToDraft(draftId: string, formData?: FormData) {
  const { status, page } = getImportReviewNavigation(
    String(formData?.get("reviewStatus") ?? "all"),
    String(formData?.get("reviewPage") ?? "1"),
  );
  redirect(buildImportReviewHref(draftId, status, page));
}

function isFileWithExtension(value: FormDataEntryValue | null, extension: string): value is File {
  return value instanceof File && value.name.toLowerCase().endsWith(extension);
}

function readImportSource(formData: FormData): ImportSource | null {
  const source = String(formData.get("source") ?? "").trim();

  if (
    source === SUI_SHOU_JI_SOURCE ||
    source === WECHAT_PAY_SOURCE ||
    source === ALIPAY_SOURCE ||
    source === CMB_SOURCE
  ) {
    return source;
  }

  return null;
}

export async function uploadImportDraft(formData: FormData) {
  let started = false;
  try {
    return await withHouseholdEncryption(extractEncryption(formData), async () => {
      started = true;
      const source = readImportSource(formData);

      if (!source) {
        redirect("/records/import?error=missing-source");
      }

      const file = formData.get("file");
      let isCmbZip = false;

      if (source === ALIPAY_SOURCE) {
        if (!isFileWithExtension(file, ".csv")) {
          redirect("/records/import?error=unsupported-alipay-file");
        }
      } else if (source === CMB_SOURCE) {
        const isCmbPdf = isFileWithExtension(file, ".pdf");
        isCmbZip = isFileWithExtension(file, ".zip");
        if (!isCmbPdf && !isCmbZip) {
          redirect("/records/import?error=unsupported-cmb-file");
        }
      } else if (!isFileWithExtension(file, ".xlsx")) {
        redirect("/records/import?error=unsupported-file");
      }

      if (!(file instanceof File)) {
        redirect("/records/import?error=upload-failed");
      }

      if (source === CMB_SOURCE && isCmbZip && !String(formData.get("zipPassword") ?? "")) {
        redirect("/records/import?error=missing-cmb-zip-password");
      }

      if (file.size > MAX_IMPORT_FILE_BYTES) {
        redirect("/records/import?error=file-too-large");
      }

      try {
        const sessionUser = await requireAppSession();
        const context = parseEntryContextFormValue(formData.get("context"));
        if (!context) redirect("/records/import?error=missing-context");
        const input = {
          buffer: Buffer.from(await file.arrayBuffer()),
          context,
          fileName: file.name,
          sessionUser,
        };
        const draft =
          source === CMB_SOURCE
            ? await createCmbImportDraft({
              ...input,
              ...(isCmbZip ? { password: String(formData.get("zipPassword") ?? "") } : {}),
            })
            : source === ALIPAY_SOURCE
              ? await createAlipayImportDraft(input)
              : source === WECHAT_PAY_SOURCE
                ? await createWechatPayImportDraft(input)
                : await createSuiShouJiImportDraft(input);

        await recordAppEvent({
          eventType: AppEventType.IMPORT_DRAFT_UPLOADED,
          householdId: sessionUser.householdId,
          memberId: sessionUser.memberId,
          metadata: { source },
          summary: "上传导入草稿",
        }).catch(() => undefined);

        redirectToDraft(draft.id);
      } catch (error) {
        if (isRedirectError(error)) {
          throw error;
        }

        if (error instanceof Error && error.message === "Unauthorized") {
          redirect("/login");
        }

        if (error instanceof ResourceBusyError) redirect(`/records/import?error=${XLSX_BUSY}`);
        if (error instanceof ResourceExpiredError) redirect(`/records/import?error=${XLSX_TIMEOUT}`);

        if (error instanceof Error && error.message === unrecognizedSuiShouJiWorkbookMessage) {
          redirect("/records/import?error=unrecognized-file");
        }

        if (error instanceof Error && error.message === unrecognizedWechatPayWorkbookMessage) {
          redirect("/records/import?error=unrecognized-wechat-pay-file");
        }

        if (error instanceof Error && error.message === unrecognizedAlipayCsvMessage) {
          redirect("/records/import?error=unrecognized-alipay-file");
        }

        if (error instanceof Error && error.message === unrecognizedCmbPdfMessage) {
          redirect("/records/import?error=unrecognized-cmb-file");
        }

        if (error instanceof Error && error.message === CMB_ZIP_PASSWORD_REQUIRED_MESSAGE) {
          redirect("/records/import?error=missing-cmb-zip-password");
        }

        if (error instanceof Error && error.message === CMB_ZIP_UNREADABLE_MESSAGE) {
          redirect("/records/import?error=unreadable-cmb-zip-file");
        }

        if (error instanceof Error && error.message === IMPORT_FILE_TOO_LARGE_MESSAGE) {
          redirect("/records/import?error=file-too-large");
        }

        if (error instanceof Error && [XLSX_BUSY, XLSX_RESOURCE_LIMIT, XLSX_TIMEOUT, XLSX_UNREADABLE].includes(error.message)) {
          redirect(`/records/import?error=${error.message}`);
        }

        redirect("/records/import?error=upload-failed");
      }
    });
  } catch (error) {
    if (started) throw error;
    if (isRedirectError(error)) {
      throw error;
    }

    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }

    if (error instanceof ResourceBusyError) redirect(`/records/import?error=${XLSX_BUSY}`);
    if (error instanceof ResourceExpiredError) redirect(`/records/import?error=${XLSX_TIMEOUT}`);

    if (error instanceof Error && error.message === unrecognizedSuiShouJiWorkbookMessage) {
      redirect("/records/import?error=unrecognized-file");
    }

    if (error instanceof Error && error.message === unrecognizedWechatPayWorkbookMessage) {
      redirect("/records/import?error=unrecognized-wechat-pay-file");
    }

    if (error instanceof Error && error.message === unrecognizedAlipayCsvMessage) {
      redirect("/records/import?error=unrecognized-alipay-file");
    }

    if (error instanceof Error && error.message === unrecognizedCmbPdfMessage) {
      redirect("/records/import?error=unrecognized-cmb-file");
    }

    if (error instanceof Error && error.message === CMB_ZIP_PASSWORD_REQUIRED_MESSAGE) {
      redirect("/records/import?error=missing-cmb-zip-password");
    }

    if (error instanceof Error && error.message === CMB_ZIP_UNREADABLE_MESSAGE) {
      redirect("/records/import?error=unreadable-cmb-zip-file");
    }

    if (error instanceof Error && error.message === IMPORT_FILE_TOO_LARGE_MESSAGE) {
      redirect("/records/import?error=file-too-large");
    }

    if (error instanceof Error && [XLSX_BUSY, XLSX_RESOURCE_LIMIT, XLSX_TIMEOUT, XLSX_UNREADABLE].includes(error.message)) {
      redirect(`/records/import?error=${error.message}`);
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

export async function savePaymentOwnerMember(formData: FormData) {
  let started = false;
  try {
    return await withHouseholdEncryption(extractEncryption(formData), async () => {
      started = true;
      const draftId = readDraftId(formData);
      const ownerMemberId = String(formData.get("ownerMemberId") ?? "").trim();

      if (!ownerMemberId) {
        redirectToDraft(draftId, formData);
      }

      const sessionUser = await requireAppSession();

      await savePaymentImportDraftOwnerMember(draftId, ownerMemberId, sessionUser);

      redirectToDraft(draftId, formData);
    });
  } catch (error) {
    if (started) throw error;
    if (error instanceof EncryptionRequestError) redirectToDraft(readDraftId(formData), formData);
    throw error;
  }
}

export async function saveWechatPayOwnerMember(formData: FormData) {
  return savePaymentOwnerMember(formData);
}

export async function saveImportMappings(formData: FormData) {
  let started = false;
  try {
    return await withHouseholdEncryption(extractEncryption(formData), async () => {
      started = true;
      const draftId = readDraftId(formData);
      const sessionUser = await requireAppSession();
      const mappings = Array.from(formData.entries()).flatMap(([key, value]) => {
        if (!key.startsWith("mapping:") || typeof value !== "string" || !value) {
          return [];
        }

        return [
          {
            categoryId: value === IGNORE_IMPORT_MAPPING_VALUE ? null : value,
            mappingKey: key.slice("mapping:".length),
          },
        ];
      });

      if (mappings.length > 0) {
        await saveImportDraftMappings(draftId, mappings, sessionUser);
      }

      redirectToDraft(draftId, formData);
    });
  } catch (error) {
    if (started) throw error;
    if (error instanceof EncryptionRequestError) redirectToDraft(readDraftId(formData), formData);
    throw error;
  }
}

export async function saveImportMappingChanges(
  draftId: string,
  mappings: ImportDraftMappingInput[], encryption?: EncryptionInput
) {
  let started = false;
  try {
    return await withHouseholdEncryption(encryption, async () => {
      started = true;
      try {
        const sessionUser = await requireAppSession();
        if (
          typeof draftId !== "string" || !draftId.trim() ||
          !Array.isArray(mappings) || mappings.some((mapping) =>
            !mapping || typeof mapping.mappingKey !== "string" || !mapping.mappingKey.trim() ||
            (mapping.categoryId !== null &&
              (typeof mapping.categoryId !== "string" || !mapping.categoryId.trim())),
          )
        ) {
          return { success: false as const, error: "IMPORT_MAPPING_SAVE_FAILED" as const };
        }

        if (mappings.length > 0) {
          await saveImportDraftMappings(draftId, mappings, sessionUser);
        }
        return { success: true as const };
      } catch {
        return { success: false as const, error: "IMPORT_MAPPING_SAVE_FAILED" as const };
      }
    });
  } catch (error) {
    if (started) throw error;
    return { success: false as const, error: "IMPORT_MAPPING_SAVE_FAILED" as const };
  }
}

export async function saveImportMemberMappings(formData: FormData) {
  let started = false;
  try {
    return await withHouseholdEncryption(extractEncryption(formData), async () => {
      started = true;
      const draftId = readDraftId(formData);
      const sessionUser = await requireAppSession();
      const mappings = Array.from(formData.entries()).flatMap(([key, value]) => {
        if (!key.startsWith("memberMapping:") || typeof value !== "string" || !value) {
          return [];
        }

        return [
          {
            externalName: key.slice("memberMapping:".length),
            memberId: value,
          },
        ];
      });

      if (mappings.length > 0) {
        await saveImportDraftMemberMappings(draftId, mappings, sessionUser);
      }

      redirectToDraft(draftId, formData);
    });
  } catch (error) {
    if (started) throw error;
    if (error instanceof EncryptionRequestError) redirectToDraft(readDraftId(formData), formData);
    throw error;
  }
}

export async function saveImportDecisions(formData: FormData) {
  let started = false;
  try {
    return await withHouseholdEncryption(extractEncryption(formData), async () => {
      started = true;
      const draftId = readDraftId(formData);
      const sessionUser = await requireAppSession();

      const decisions = Array.from(formData.entries()).flatMap(([key, value]) =>
        key.startsWith("decision:") && (value === ImportRowDecision.KEEP || value === ImportRowDecision.SKIP)
          ? [{ rowId: key.slice("decision:".length), decision: value }]
          : [],
      );
      await setImportDraftRowDecisions(draftId, decisions, sessionUser);

      redirectToDraft(draftId, formData);
    });
  } catch (error) {
    if (started) throw error;
    if (error instanceof EncryptionRequestError) redirectToDraft(readDraftId(formData), formData);
    throw error;
  }
}

export async function saveImportReviewDecisions(
  draftId: string,
  decisions: Array<{ rowId: string; decision: ImportRowDecision }>, encryption?: EncryptionInput
) {
  let started = false;
  try {
    return await withHouseholdEncryption(encryption, async () => {
      started = true;
      try {
        const sessionUser = await requireAppSession();
        await setImportDraftRowDecisions(draftId, decisions, sessionUser);
        return { success: true as const };
      } catch {
        return { success: false as const };
      }
    });
  } catch (error) {
    if (started) throw error;
    return { success: false as const };
  }
}

export async function getImportCandidateDetail(draftId: string, rowId: string, candidateId: string, encryption?: EncryptionInput) {
  let started = false;
  try {
    return await withHouseholdEncryption(encryption, async () => {
      started = true;
      try {
        const sessionUser = await requireAppSession();
        const record = await getImportDuplicateCandidate(draftId, rowId, candidateId, sessionUser);
        return record
          ? { success: true as const, record: { ...record, occurredAt: record.occurredAt.toISOString() } }
          : { success: false as const };
      } catch {
        return { success: false as const };
      }
    }, { readOnly: true });
  } catch (error) {
    if (started) throw error;
    return { success: false as const };
  }
}

async function confirmDraftAndRecordEvent(draftId: string) {
  const sessionUser = await requireAppSession();
  const result = await confirmImportDraft(draftId, sessionUser);

  if (result.completedNow) {
    await recordAppEvent({
      eventType: AppEventType.IMPORT_CONFIRMED,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      metadata: { count: result.createdCount, source: result.source },
      summary: `确认导入 ${result.createdCount} 笔`,
    }).catch(() => undefined);
  }

  return result;
}

export async function confirmImportDraftAction(formData: FormData) {
  let started = false;
  try {
    return await withHouseholdEncryption(extractEncryption(formData), async () => {
      started = true;
      const draftId = readDraftId(formData);
      try {
        const result = await confirmDraftAndRecordEvent(draftId);
        redirect(result.requiresReview
          ? `/records/import?draft=${encodeURIComponent(draftId)}&notice=IMPORT_DRAFT_CHANGED`
          : `/records/import?draft=${encodeURIComponent(draftId)}&completed=1`);
      } catch (error) {
        if (error instanceof ResourceBusyError || error instanceof ResourceExpiredError) {
          redirect(`/records/import?draft=${encodeURIComponent(draftId)}&error=${error instanceof ResourceBusyError ? XLSX_BUSY : XLSX_TIMEOUT}`);
        }
        throw error;
      }
    });
  } catch (error) {
    if (started) throw error;
    const draftId = String(formData.get("draftId") ?? "");
    if (error instanceof ResourceBusyError || error instanceof ResourceExpiredError) {
      redirect(`/records/import?draft=${encodeURIComponent(draftId)}&error=${error instanceof ResourceBusyError ? XLSX_BUSY : XLSX_TIMEOUT}`);
    }
    throw error;
  }
}

export async function confirmImportReviewDraft(draftId: string, encryption?: EncryptionInput) {
  let started = false;
  try {
    return await withHouseholdEncryption(encryption, async () => {
      started = true;
      try {
        const result = await confirmDraftAndRecordEvent(draftId);
        return { success: true as const, requiresReview: result.requiresReview };
      } catch (error) {
        if (error instanceof ResourceBusyError) return { success: false as const, error: "BUSY" as const };
        return { success: false as const };
      }
    });
  } catch (error) {
    if (started) throw error;
    if (error instanceof ResourceBusyError) return { success: false as const, error: "BUSY" as const };
    return { success: false as const };
  }
}
