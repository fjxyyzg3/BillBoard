import { clearTransactions } from "./db-cleanup";

export default async function globalSetup() {
  await clearTransactions();
}
