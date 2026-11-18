export declare function createDesktopStaging(options: {
  directory: string; origin: string; publicKey: string | Buffer; version: string;
  appId?: string; productName?: string; repositoryRoot?: string;
}): string;
export declare function buildDesktopInstaller(options: { stageDirectory: string; outputDirectory: string }): string;
