import { PrismaClient } from "@prisma/client";

export async function clearTransactions() {
  const prisma = new PrismaClient();

  try {
    await prisma.transaction.deleteMany({});
  } finally {
    await prisma.$disconnect();
  }
}
