export function assertEncryptionTransport(headers: Pick<Headers, "get">, requestUrl?: string) {
  const url = requestUrl ? new URL(requestUrl) : undefined;
  const origin = headers.get("origin"), host = headers.get("host") ?? url?.host;
  const forwarded = headers.get("x-forwarded-host"), site = headers.get("sec-fetch-site");
  const protocol = headers.get("x-forwarded-proto") ?? url?.protocol.slice(0, -1) ?? "http";
  try {
    if (!origin || !host || (forwarded && forwarded !== host) || (site && site !== "same-origin") || !["https", "http"].includes(protocol) || origin !== new URL(`${protocol}://${host}`).origin || (protocol !== "https" && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname))) throw new Error();
  } catch { throw new Error("Forbidden"); }
}
