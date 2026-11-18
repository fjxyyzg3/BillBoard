import { z } from "zod";

export const IMPORT_AGENT_SCHEMA_VERSION = "import-category-agent.v1";
export const MAX_AGENT_GROUPS = 25;
export const MAX_AGENT_TEXT_LENGTH = 200;
export const MAX_AGENT_PRODUCTS = 3;
export const MAX_AGENT_BODY_BYTES = 256 * 1024;
export const MAX_AGENT_RESPONSE_BYTES = 64 * 1024;

const transactionType = z.enum(["INCOME", "EXPENSE"]);
const groupId = z.string().regex(/^g\d{1,6}$/);
const categoryId = z.string().regex(/^c\d{1,6}$/);
const text = z.string().max(MAX_AGENT_TEXT_LENGTH);

export const importAgentRequestSchema = z.object({
  schemaVersion: z.literal(IMPORT_AGENT_SCHEMA_VERSION),
  groups: z.array(z.object({
    id: groupId,
    source: z.enum(["sui_shou_ji", "wechat_pay", "alipay", "cmb"]),
    transactionType,
    primaryCategory: text,
    secondaryCategory: text,
    products: z.array(text).max(MAX_AGENT_PRODUCTS),
  }).strict()).min(1).max(MAX_AGENT_GROUPS),
  categories: z.array(z.object({
    id: categoryId,
    name: text.min(1),
    displayName: text.min(1),
    type: transactionType,
  }).strict()).min(1).max(100),
}).strict().superRefine((request, context) => {
  for (const field of ["groups", "categories"] as const) {
    if (new Set(request[field].map(({ id }) => id)).size !== request[field].length) {
      context.addIssue({ code: "custom", path: [field], message: "Duplicate identifiers" });
    }
  }
});

export const importAgentResponseSchema = z.object({
  schemaVersion: z.literal(IMPORT_AGENT_SCHEMA_VERSION),
  suggestions: z.array(z.discriminatedUnion("action", [
    z.object({ groupId, action: z.literal("map"), categoryId }).strict(),
    z.object({ groupId, action: z.literal("ignore") }).strict(),
    z.object({ groupId, action: z.literal("uncertain") }).strict(),
  ])).max(MAX_AGENT_GROUPS),
}).strict().superRefine((response, context) => {
  if (new Set(response.suggestions.map(({ groupId: id }) => id)).size !== response.suggestions.length) {
    context.addIssue({ code: "custom", path: ["suggestions"], message: "Duplicate suggestions" });
  }
});

export type ImportAgentRequest = z.infer<typeof importAgentRequestSchema>;
export type ImportAgentResponse = z.infer<typeof importAgentResponseSchema>;

export function validateAgentRequest(input: unknown): ImportAgentRequest {
  return importAgentRequestSchema.parse(input);
}

export function validateAgentResponse(request: ImportAgentRequest, input: unknown): ImportAgentResponse {
  const response = importAgentResponseSchema.parse(input);
  const groups = new Map(request.groups.map((group) => [group.id, group]));
  const categories = new Map(request.categories.map((category) => [category.id, category]));

  for (const suggestion of response.suggestions) {
    const group = groups.get(suggestion.groupId);
    if (!group) throw new Error("Unknown classification group");
    if (suggestion.action === "map") {
      const category = categories.get(suggestion.categoryId);
      if (!category || category.type !== group.transactionType) {
        throw new Error("Invalid classification category");
      }
    }
  }
  return response;
}
