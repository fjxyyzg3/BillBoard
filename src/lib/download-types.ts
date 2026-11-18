export type DownloadPlatform = "android" | "windows";

export type DownloadAvailability =
  | { status: "available"; version: string; size: number; minSdk?: number }
  | { status: "unavailable" | "busy" };

export type DownloadCatalog = Record<DownloadPlatform, DownloadAvailability>;
