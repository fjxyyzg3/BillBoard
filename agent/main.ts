import { createImportAgentServer } from "./server";
import { createAgentRuntimes } from "./provider";

try {
  const shutdown = new AbortController();
  const runtimes = createAgentRuntimes();
  const server = createImportAgentServer({
    token: process.env.IMPORT_AGENT_TOKEN ?? "",
    shutdownSignal: shutdown.signal,
    classify: runtimes.classify,
    parseExpenses: runtimes.parseExpenses,
    analyzeBill: runtimes.analyzeBill,
    reconcileBill: runtimes.reconcileBill,
  });
  const stop = () => {
    shutdown.abort();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.on("error", () => {
    process.stderr.write("Import agent service could not start.\n");
    process.exit(1);
  });
  server.listen(3100, "0.0.0.0");
} catch {
  process.stderr.write("Import agent configuration is invalid.\n");
  process.exit(1);
}
