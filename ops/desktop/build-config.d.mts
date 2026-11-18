import type { KeyObject } from "node:crypto";

export declare const DESKTOP_APP_ID: "com.billboard.desktop";
export declare const DESKTOP_ELECTRON_VERSION: "45.0.0";
export declare const DESKTOP_BUILDER_VERSION: "26.15.3";
export declare function validateDesktopOrigin(value: unknown): string;
export declare function validateDesktopVersion(version: unknown): string;
export declare function validateDesktopAppIdentity(appId: string, origin: string): void;
export declare function redactDesktopOutput(value: unknown, privateValues?: string[]): string;
export declare function validateDesktopPrivateKeyPath(path: string, repositoryRoots: string[]): string;
export declare function protectDesktopPrivatePath(path: string, options?: { directory?: boolean }): void;
export declare function publicKeyFingerprint(publicKey: string | Buffer): string;
export type DesktopSigning = { privateKey: KeyObject; publicKey: string; publicKeyFingerprint: string };
export declare function loadDesktopSigningKey(path: string, options?: { repositoryRoots?: string[] }): DesktopSigning;
export declare function initializeDesktopSigning(path: string, options?: { repositoryRoots?: string[] }): DesktopSigning;
