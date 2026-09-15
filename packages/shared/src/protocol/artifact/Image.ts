import type { ArtifactSourceDescriptor } from "./Transfer.js";

export type ArtifactImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ArtifactImageContent {
    blake3: string;
    bytes: number;
    content: string;
    encoding: "base64";
    imageRef: string;
    mediaType: ArtifactImageMediaType;
}

export type ArtifactStoredImageResult = ArtifactImageContent;

export type ArtifactViewImageInput =
    | {
          handle: string;
          instance?: string;
          path?: never;
      }
    | {
          handle?: never;
          instance?: string;
          path: string;
          workspace: string;
      };

export interface ArtifactViewImageResult extends ArtifactImageContent {
    name: string;
    source: ArtifactSourceDescriptor;
}
