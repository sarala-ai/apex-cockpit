import { afterEach, describe, expect, it, vi } from "vitest";

const { saveMock, getMetadataMock, deleteMock, fileMock, bucketMock } = vi.hoisted(() => {
  const saveMock = vi.fn();
  const getMetadataMock = vi.fn();
  const deleteMock = vi.fn();
  const fileMock = vi.fn(() => ({
    save: saveMock,
    getMetadata: getMetadataMock,
    createReadStream: vi.fn(() => ({})),
    delete: deleteMock,
  }));
  const bucketMock = vi.fn(() => ({ file: fileMock }));
  return { saveMock, getMetadataMock, deleteMock, fileMock, bucketMock };
});

vi.mock("@google-cloud/storage", () => ({
  Storage: vi.fn(function () {
    return { bucket: bucketMock };
  }),
}));

const { createGcsStorageProvider } = await import("./gcs-provider.js");
const { createStorageProviderFromConfig } = await import("./provider-registry.js");

describe("gcs storage provider (secretless / ADC)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("puts an object under the configured bucket + prefix", async () => {
    const provider = createGcsStorageProvider({ bucket: "b", prefix: "pre" });
    expect(provider.id).toBe("gcs");
    await provider.putObject({ objectKey: "co/x.bin", body: Buffer.from("hi"), contentType: "application/octet-stream", contentLength: 2 });
    expect(bucketMock).toHaveBeenCalledWith("b");
    expect(fileMock).toHaveBeenCalledWith("pre/co/x.bin");
    expect(saveMock).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ contentType: "application/octet-stream", resumable: false }));
  });

  it("headObject reports existence + metadata, and false on 404", async () => {
    const provider = createGcsStorageProvider({ bucket: "b" });
    getMetadataMock.mockResolvedValueOnce([{ contentType: "text/plain", size: "5", etag: "e", updated: "2026-01-01T00:00:00Z" }]);
    const head = await provider.headObject({ objectKey: "k" });
    expect(head).toMatchObject({ exists: true, contentType: "text/plain", contentLength: 5, etag: "e" });

    getMetadataMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: 404 }));
    expect(await provider.headObject({ objectKey: "missing" })).toEqual({ exists: false });
  });

  it("deleteObject is a no-op on 404", async () => {
    const provider = createGcsStorageProvider({ bucket: "b" });
    deleteMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: 404 }));
    await expect(provider.deleteObject({ objectKey: "missing" })).resolves.toBeUndefined();
  });

  it("registry constructs the gcs provider when storageProvider is 'gcs'", () => {
    const provider = createStorageProviderFromConfig({
      storageProvider: "gcs",
      storageGcsBucket: "sarala-apex-cockpit-storage",
      storageGcsPrefix: "",
      storageGcsProjectId: undefined,
    } as never);
    expect(provider.id).toBe("gcs");
    expect(bucketMock).toHaveBeenCalledWith("sarala-apex-cockpit-storage");
  });
});
