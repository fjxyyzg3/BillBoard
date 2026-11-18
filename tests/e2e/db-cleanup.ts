import { PrismaClient } from "@prisma/client";
import { resolveTestDatabases } from "../../ops/testing/environment";

function assertSafeE2eDatabase() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("E2E cleanup must not run with NODE_ENV=production");
  }

  const urls = resolveTestDatabases(process.env);
  if (process.env.DATABASE_URL !== urls.e2e) {
    throw new Error("E2E cleanup requires the configured E2E-only test database");
  }
}

export async function resetLoginBudget(tokens = 10) {
  assertSafeE2eDatabase();
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRaw`
      UPDATE "LoginBudget" SET "tokens" = ${tokens}, "refilled_at" = clock_timestamp()
      WHERE "id" = 1
    `;
  } finally {
    await prisma.$disconnect();
  }
}

export async function clearTransactions() {
  assertSafeE2eDatabase();

  const prisma = new PrismaClient();

  try {
    await prisma.$transaction([
      prisma.billReconciliationApplication.deleteMany({}),
      prisma.billAnalysisRequest.deleteMany({}),
      prisma.billAnalysisReport.deleteMany({}),
      prisma.importDraftRow.deleteMany({}),
      prisma.importDraft.deleteMany({}),
      prisma.importCategoryMapping.deleteMany({}),
      prisma.importMemberMapping.deleteMany({}),
      prisma.naturalLanguageRequest.deleteMany({}),
      prisma.voiceProcessingAdmission.deleteMany({}),
      prisma.resourceLease.deleteMany({}),
      prisma.resourceWindow.deleteMany({}),
      prisma.transaction.deleteMany({}),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

export async function resetProcessingTestState() {
  assertSafeE2eDatabase();
  const prisma = new PrismaClient();
  try {
    const emails = [process.env.SEED_USER_A_EMAIL, process.env.SEED_USER_B_EMAIL].filter((email): email is string => Boolean(email));
    await prisma.$transaction([
      prisma.resourceLease.deleteMany({}), prisma.resourceWindow.deleteMany({}),
      prisma.identityRateLimit.deleteMany({ where: { id: "global" } }),
      // Keep each case independent without deleting historical session identities.
      prisma.appSession.updateMany({ where: { user: { email: { in: emails } }, revokedAt: null }, data: { revokedAt: new Date() } }),
      // Only synthetic seed accounts opt in here; production seed never records consent.
      prisma.user.updateMany({ where: { email: { in: emails }, status: "ACTIVE" }, data: { aiProcessingEnabled: true, voiceProcessingEnabled: true } }),
    ]);
  } finally { await prisma.$disconnect(); }
}
