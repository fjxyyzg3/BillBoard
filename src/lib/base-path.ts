const SAFE_BASE_PATH_PATTERN = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

export function normalizeAppBasePath(value = process.env.APP_BASE_PATH) {
  const trimmed = value?.trim() ?? "";

  if (!trimmed || trimmed === "/") {
    return "";
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error("APP_BASE_PATH must be a relative URL path");
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized = withLeadingSlash.replace(/\/+$/, "");

  if (!SAFE_BASE_PATH_PATTERN.test(normalized)) {
    throw new Error("APP_BASE_PATH must be a relative URL path");
  }

  return normalized;
}

export function withAppBasePath(pathname: `/${string}`, basePath = normalizeAppBasePath()) {
  return `${basePath}${pathname}` || "/";
}
