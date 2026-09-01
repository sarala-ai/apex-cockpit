import { Storage } from "@google-cloud/storage";
import { Readable } from "node:stream";
import type { StorageProvider, GetObjectResult, HeadObjectResult } from "./types.js";
import { notFound, unprocessable } from "../errors.js";

interface GcsProviderConfig {
  bucket: string;
  prefix?: string;
  projectId?: string;
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildKey(prefix: string, objectKey: string): string {
  return prefix ? `${prefix}/${objectKey}` : objectKey;
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: number }).code === 404;
}

function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Native GCS storage provider. Authenticates purely via Application Default
 * Credentials — Workload Identity / the metadata service account on Cloud Run,
 * or `gcloud auth application-default` locally. No static keys or HMAC secrets
 * are accepted or stored; this is the secretless counterpart to the s3 provider.
 */
export function createGcsStorageProvider(config: GcsProviderConfig): StorageProvider {
  const bucketName = config.bucket.trim();
  if (!bucketName) throw unprocessable("GCS storage bucket is required");

  const prefix = normalizePrefix(config.prefix);
  const storage = new Storage(config.projectId ? { projectId: config.projectId } : {});
  const bucket = storage.bucket(bucketName);

  return {
    id: "gcs",

    async putObject(input) {
      const file = bucket.file(buildKey(prefix, input.objectKey));
      await file.save(input.body, {
        contentType: input.contentType,
        resumable: false,
      });
    },

    async getObject(input): Promise<GetObjectResult> {
      const file = bucket.file(buildKey(prefix, input.objectKey));
      try {
        const [metadata] = await file.getMetadata();
        const stream = file.createReadStream(
          input.range ? { start: input.range.start, end: input.range.end } : {},
        );
        // getMetadata already confirmed existence; a 404 on the stream would
        // surface as a stream 'error' event to the caller.
        return {
          stream: stream as unknown as Readable,
          contentType: metadata.contentType,
          contentLength: toNumber(metadata.size),
          etag: metadata.etag,
          lastModified: toDate(metadata.updated),
        };
      } catch (err) {
        if (isNotFound(err)) throw notFound("Object not found");
        throw err;
      }
    },

    async headObject(input): Promise<HeadObjectResult> {
      const file = bucket.file(buildKey(prefix, input.objectKey));
      try {
        const [metadata] = await file.getMetadata();
        return {
          exists: true,
          contentType: metadata.contentType,
          contentLength: toNumber(metadata.size),
          etag: metadata.etag,
          lastModified: toDate(metadata.updated),
        };
      } catch (err) {
        if (isNotFound(err)) return { exists: false };
        throw err;
      }
    },

    async deleteObject(input): Promise<void> {
      const file = bucket.file(buildKey(prefix, input.objectKey));
      try {
        await file.delete();
      } catch (err) {
        // Deleting a missing object is a no-op, matching S3 semantics.
        if (isNotFound(err)) return;
        throw err;
      }
    },
  };
}
