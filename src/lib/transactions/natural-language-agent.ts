import {
  validateNaturalLanguageResponse,
  type NaturalLanguageRequest,
  type NaturalLanguageResponse,
} from "./natural-language-protocol";
import type { NaturalLanguageErrorCode } from "./natural-language-types";

const maxResponseBytes = 64 * 1024;

export class NaturalLanguageAgentError extends Error {
  constructor(readonly code: NaturalLanguageErrorCode) { super(code); }
}

async function readBody(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > maxResponseBytes || !response.body) {
    throw new NaturalLanguageAgentError("INVALID_RESPONSE");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw new NaturalLanguageAgentError("INVALID_RESPONSE");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof NaturalLanguageAgentError) throw error;
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new NaturalLanguageAgentError("TIMEOUT");
    throw new NaturalLanguageAgentError("INVALID_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}

export async function parseNaturalLanguageExpenses(request: NaturalLanguageRequest, signal?: AbortSignal): Promise<NaturalLanguageResponse> {
  let endpoint: URL;
  const token = process.env.IMPORT_AGENT_TOKEN?.trim();
  try {
    const configured = new URL(process.env.IMPORT_AGENT_URL?.trim() ?? "");
    if (!token || !["http:", "https:"].includes(configured.protocol) || configured.username || configured.password) throw new Error("Invalid endpoint");
    endpoint = new URL("/parse-expenses", configured);
  } catch { throw new NaturalLanguageAgentError("UNAVAILABLE"); }
  try {
    const response = await fetch(endpoint, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(request), cache: "no-store", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(55_000)]) : AbortSignal.timeout(55_000),
    });
    if (!response.ok) {
      let code: unknown;
      try {
        const body = await readBody(response);
        if (body && typeof body === "object" && "error" in body) code = body.error;
      } catch { /* Only fixed service error codes are public. */ }
      if (code === "authentication_required") throw new NaturalLanguageAgentError("AUTHENTICATION_REQUIRED");
      if (response.status === 429 || code === "busy") throw new NaturalLanguageAgentError("BUSY");
      if (response.status === 504 || code === "timeout") throw new NaturalLanguageAgentError("TIMEOUT");
      if (response.status === 502 || code === "invalid_response") throw new NaturalLanguageAgentError("INVALID_RESPONSE");
      throw new NaturalLanguageAgentError("UNAVAILABLE");
    }
    try { return validateNaturalLanguageResponse(request, await readBody(response)); }
    catch (error) {
      if (error instanceof NaturalLanguageAgentError) throw error;
      throw new NaturalLanguageAgentError("INVALID_RESPONSE");
    }
  } catch (error) {
    if (error instanceof NaturalLanguageAgentError) throw error;
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new NaturalLanguageAgentError("TIMEOUT");
    throw new NaturalLanguageAgentError("UNAVAILABLE");
  }
}
