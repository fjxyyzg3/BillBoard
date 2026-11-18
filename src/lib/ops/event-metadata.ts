import { z } from "zod";
import {
  ALIPAY_SOURCE,
  CMB_SOURCE,
  SUI_SHOU_JI_SOURCE,
  WECHAT_PAY_SOURCE,
} from "@/lib/imports/types";

const importSourceMetadataValues = [
  SUI_SHOU_JI_SOURCE,
  WECHAT_PAY_SOURCE,
  ALIPAY_SOURCE,
  CMB_SOURCE,
] as const;

const appEventMetadataSchema = z
  .object({
    count: z.number().int().min(0).max(100000).optional(),
    source: z.enum(importSourceMetadataValues).optional(),
    transactionType: z.enum(["expense", "income"]).optional(),
  })
  .strict();

export type AppEventMetadataInput = z.input<typeof appEventMetadataSchema>;
export type AppEventMetadata = z.output<typeof appEventMetadataSchema>;

export function canExposeAppEventBusiness(config: { mode: string; activeOperationId: string | null } | null | undefined) {
  return !config || (config.mode === "UNENCRYPTED" && config.activeOperationId === null);
}

const allowedAppEventPathnames = new Set([
  "/login",
  "/home",
  "/add",
  "/records",
  "/records/import",
]);

const allowedAppEventSummaries = new Set([
  "登录成功",
  "登录失败",
  "登录被临时锁定",
  "访问 首页",
  "访问 记一笔",
  "访问 记录",
  "访问 导入记录",
  "新增收入记录",
  "新增支出记录",
  "编辑收入记录",
  "编辑支出记录",
  "删除收入记录",
  "删除支出记录",
  "上传导入草稿",
]);

const importConfirmedSummaryPattern = /^确认导入 [0-9]{1,6} 笔$/;

function removeUndefinedValues(metadata: AppEventMetadata) {
  const sanitized: Record<string, number | string> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export function sanitizeAppEventMetadata(input: unknown) {
  if (input === undefined || input === null) {
    return undefined;
  }

  const result = appEventMetadataSchema.safeParse(input);

  if (!result.success) {
    throw new Error("Unsupported app event metadata");
  }

  const metadata = removeUndefinedValues(result.data);

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function sanitizeAppEventPath(input: unknown) {
  if (input === undefined || input === null) {
    return null;
  }

  if (typeof input !== "string") {
    throw new Error("Unsupported app event path");
  }

  const isRelativePath = input.startsWith("/");
  let url: URL;

  try {
    url = isRelativePath
      ? new URL(input, "https://app.invalid")
      : new URL(input);
  } catch {
    throw new Error("Unsupported app event path");
  }

  if (!isRelativePath && !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Unsupported app event path");
  }

  if (!allowedAppEventPathnames.has(url.pathname)) {
    throw new Error("Unsupported app event path");
  }

  return url.pathname;
}

export function sanitizeAppEventSummary(input: unknown) {
  if (input === undefined || input === null) {
    return null;
  }

  if (typeof input !== "string") {
    throw new Error("Unsupported app event summary");
  }

  if (
    allowedAppEventSummaries.has(input) ||
    importConfirmedSummaryPattern.test(input)
  ) {
    return input;
  }

  throw new Error("Unsupported app event summary");
}
