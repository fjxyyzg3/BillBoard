import { clearTransactions } from "./db-cleanup";
import { startE2eDevServer } from "./dev-server";
import { startAgentFixture } from "./agent-fixture";
import { startMailFixture } from "./mail-fixture";

export default async function globalSetup() {
  await clearTransactions();
  const stopAgent = await startAgentFixture();
  const stopMail = await startMailFixture();
  try {
    await startE2eDevServer();
    return async () => { await stopMail(); await stopAgent(); };
  } catch (error) {
    await stopMail();
    await stopAgent();
    throw error;
  }
}
