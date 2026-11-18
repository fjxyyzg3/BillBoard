import { PrismaClient } from "@prisma/client";
import { encryptionDatabase } from "./encryption/database";

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

export const physicalDb =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Prisma validation errors can contain complete query arguments.
    log: [],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = physicalDb;
}

export const db = encryptionDatabase(physicalDb);
