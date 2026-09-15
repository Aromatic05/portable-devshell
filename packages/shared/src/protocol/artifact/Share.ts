import type { ArtifactSourceDescriptor } from "./Transfer.js";

export const artifactShareStates = [
    "active",
    "exhausted",
    "expired",
    "revoked",
] as const;
export type ArtifactShareState = (typeof artifactShareStates)[number];

export type ArtifactShareInput =
    | {
          expiresInSeconds?: number;
          handle: string;
          instance?: string;
          maxDownloads?: number;
          path?: never;
      }
    | {
          expiresInSeconds?: number;
          handle?: never;
          instance?: string;
          maxDownloads?: number;
          path: string;
          workspace: string;
      };

export interface ArtifactShareResult {
    blake3: string;
    bytes: number;
    downloadCount?: number;
    downloadName: string;
    expiresAtMs: number;
    maxDownloads?: number;
    mediaType: string;
    shareId: string;
    source: ArtifactSourceDescriptor;
    state: ArtifactShareState;
    url: string;
}

export interface ArtifactShareRevokeResult {
    revoked: true;
    shareId: string;
}
