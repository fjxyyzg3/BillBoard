import { getOpsAdminPasswordHash } from "@/lib/ops/auth";

export type OpsAdminConfig = {
  enabled: boolean;
  hasPasswordHash: boolean;
  instance: boolean;
};

export function getOpsAdminConfig(): OpsAdminConfig {
  return {
    enabled: process.env.OPS_ADMIN_ENABLED === "true",
    hasPasswordHash: Boolean(getOpsAdminPasswordHash()),
    instance: process.env.OPS_ADMIN_INSTANCE === "true",
  };
}

export function isOpsAdminInstance(): boolean {
  return getOpsAdminConfig().instance;
}
