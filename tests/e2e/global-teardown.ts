import { clearTransactions } from "./db-cleanup";

export default async function globalTeardown() {
  await clearTransactions();
}
