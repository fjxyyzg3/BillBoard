import { createRequire } from "node:module";
import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { normalizeAppBasePath } from "./src/lib/base-path";
import { createContentSecurityPolicy } from "./src/lib/content-security-policy";

const basePath = normalizeAppBasePath();

const allowedDevOrigins = [
  "127.0.0.1",
  ...(process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Keep the existing 20 MiB statement limit plus bounded multipart and key metadata.
    serverActions: { bodySizeLimit: "25mb" },
    proxyClientMaxBodySize: "25mb",
  },
  headers() {
    // Configured headers take precedence over Route Handler response headers.
    const noReferrerApis = [
      "/api/voice/audio", "/api/records/export", "/api/household/view", "/api/household/encryption",
      "/api/reports/analyze", "/api/reports/reconcile",
      "/api/downloads/:path*", "/api/android/update/:path*", "/api/windows/update/:path*",
    ];
    return [{
      source: "/:path*",
      headers: [{
        key: "Permissions-Policy",
        value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()",
      }, {
        key: "X-Content-Type-Options",
        value: "nosniff",
      }, {
        key: "Referrer-Policy",
        value: "same-origin",
      }, {
        key: "X-Frame-Options",
        value: "DENY",
      }, {
        // Browsers honor HSTS only over HTTPS. Do not opt other subdomains in.
        key: "Strict-Transport-Security",
        value: "max-age=31536000",
      }, {
        key: "Content-Security-Policy",
        value: createContentSecurityPolicy(),
      }],
    }, ...noReferrerApis.map((source) => ({
      source,
      headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
    })), ...["/account-link", "/forgot-password", "/account/:path*"].map((source) => ({
      source,
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ],
    }))];
  },
  logging: {
    // Server Function arguments may contain credentials or private transaction transcripts.
    serverFunctions: false,
    // The provider-only audio URL contains a short-lived bearer capability.
    incomingRequests: { ignore: [/^\/api\/voice\/audio\/?(?:\?|$)/] },
  },
  // The development indicator otherwise covers the mobile navigation in E2E.
  devIndicators: process.env.PLAYWRIGHT_TEST_BASE_URL ? false : undefined,
  // Keep Auth.js forms on the browser fixture's original loopback origin.
  skipProxyUrlNormalize: process.env.PLAYWRIGHT_TEST_BASE_URL ? true : undefined,
  // Voice files and private configuration are runtime inputs, never deployment assets.
  outputFileTracingExcludes: {
    "/api/voice/*": ["./tmp/**/*", "./.env*.local"],
  },
  // PDF.js loads its canvas package and native binding dynamically in Node.js.
  outputFileTracingIncludes: {
    "/records/import": [
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-*/**/*",
    ],
  },
  allowedDevOrigins,
  ...(basePath ? { basePath } : {}),
  turbopack: {
    root: process.cwd(),
  },
};

export default async function getNextConfig(phase: string): Promise<NextConfig> {
  if (phase !== PHASE_PRODUCTION_BUILD) return nextConfig;

  // Includes only copy matching files; they do not trace the child process imports.
  const requireFromProject = createRequire(path.join(process.cwd(), "package.json"));
  const { nodeFileTrace } = requireFromProject("next/dist/compiled/@vercel/nft") as {
    nodeFileTrace: (
      files: string[],
      options: { base: string; processCwd: string },
    ) => Promise<{ fileList: Set<string>; warnings: Set<Error> }>;
  };
  const trace = await nodeFileTrace(["src/lib/imports/xlsx-reader.mjs"], {
    base: process.cwd(),
    processCwd: process.cwd(),
  });
  if (trace.warnings.size > 0) {
    throw new Error("Could not trace every XLSX parser dependency. Check installed production packages.");
  }

  return {
    ...nextConfig,
    outputFileTracingIncludes: {
      ...nextConfig.outputFileTracingIncludes,
      "/records/import": [
        ...(nextConfig.outputFileTracingIncludes?.["/records/import"] ?? []),
        ...Array.from(trace.fileList, (file) => `./${file.replaceAll("\\", "/")}`),
      ],
    },
  };
}
