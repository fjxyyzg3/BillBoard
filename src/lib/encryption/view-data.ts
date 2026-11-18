export type HouseholdPage = "home" | "add" | "records" | "reconciliation" | "import" | "mappings" | "ledgers";
export const householdPages: Readonly<Record<string, HouseholdPage>> = {
  "/home": "home", "/add": "add", "/records": "records", "/records/reconcile": "reconciliation", "/records/import": "import", "/records/import/mappings": "mappings", "/ledgers": "ledgers",
};
type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };
const forbiddenKeys = new Set(["code", "secret", "ring", "keyRing", "householdKey", "password", "passwordHash", "appSessionId", "email"]);

export function encodeViewData(value: unknown): WireValue {
  if (value === undefined) return { $householdValue: "undefined" };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return { $householdValue: "date", value: value.toISOString() };
  if (value instanceof URLSearchParams) return { $householdValue: "params", value: value.toString() };
  if (Array.isArray(value)) return value.map(encodeViewData);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (forbiddenKeys.has(key)) throw new Error("PRIVATE_VIEW_DATA");
      return [key, encodeViewData(item)];
    }));
  }
  throw new Error("INVALID_VIEW_DATA");
}

export function decodeViewData(value: WireValue): unknown {
  if (Array.isArray(value)) return value.map(decodeViewData);
  if (value && typeof value === "object") {
    if (value.$householdValue === "undefined" && Object.keys(value).length === 1) return undefined;
    if (value.$householdValue === "date" && typeof value.value === "string" && Object.keys(value).length === 2) return new Date(value.value);
    if (value.$householdValue === "params" && typeof value.value === "string" && Object.keys(value).length === 2) return new URLSearchParams(value.value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeViewData(item)]));
  }
  return value;
}
