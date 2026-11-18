export type AndroidEnvironment = {
  config: Record<string, string>;
  java: string;
  env: NodeJS.ProcessEnv;
};

export declare const repoRoot: string;
export declare const privateConfigPath: string;
export declare function androidEnvironment(options?: { signing?: boolean }): AndroidEnvironment;
export declare function runAndroidTool(
  executable: string,
  args: string[],
  environment: AndroidEnvironment,
  options?: { showOutput?: boolean; cwd?: string },
): string;
export declare function runGradle(tasks: string[], environment: AndroidEnvironment): string;
