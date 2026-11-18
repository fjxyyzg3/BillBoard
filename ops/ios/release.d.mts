type Coverage = Record<string, { baseline: number; reruns: number[]; full: boolean; passed: boolean }>;
export declare function verificationCoverage(reports: unknown[], tree: string, retained?: string[]): Coverage;
export declare function requireVerification(receipt: unknown, sha: string, tree: string): unknown;
export declare function publishIosRelease(directory: string, input: unknown, ipa: Buffer): Promise<"older" | "current" | "published">;
