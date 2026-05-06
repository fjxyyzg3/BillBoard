import { PrismaClient } from "@prisma/client";

function assertSafeE2eDatabase() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("E2E cleanup must not run with NODE_ENV=production");
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for E2E cleanup");
  }

  const parsedUrl = new URL(databaseUrl);
  const databaseName = parsedUrl.pathname.replace(/^\//, "");
  const hostIsLocal = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost";
  const databaseIsDevOrTest = /(?:dev|test)/i.test(databaseName);

  if (!hostIsLocal || !databaseIsDevOrTest) {
    throw new Error("Refusing to run E2E cleanup against a non-dev/test database");
  }
}

export async function clearTransactions() {
  assertSafeE2eDatabase();

  const prisma = new PrismaClient();

  try {
    await prisma.$transaction([
      prisma.importDraftRow.deleteMany({}),
      prisma.importDraft.deleteMany({}),
      prisma.importCategoryMapping.deleteMany({}),
      prisma.transaction.deleteMany({}),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}
