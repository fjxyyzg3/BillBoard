import { clearTransactions } from "./db-cleanup";
import { stopE2eDevServer } from "./dev-server";

export default async function globalTeardown() {
  try {
    await clearTransactions();
  } finally {
    stopE2eDevServer();
  }
}
