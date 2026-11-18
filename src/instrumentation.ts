export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startRecordExportCleanup } = await import("./lib/exports/temp-file");
    await startRecordExportCleanup();
  }
}
