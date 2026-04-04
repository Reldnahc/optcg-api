import { CopyObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getScanIngestS3Config } from "./config.js";

let s3Client: S3Client | null = null;

function getS3Client(region: string): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region });
  }
  return s3Client;
}

function extractImageExtension(value: string | null | undefined): string {
  const normalized = (value ?? "").split("?")[0].trim().toLowerCase();
  if (normalized.endsWith(".jpg")) return ".jpg";
  if (normalized.endsWith(".jpeg")) return ".jpeg";
  if (normalized.endsWith(".webp")) return ".webp";
  return ".png";
}

function buildPublicUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${key}`;
}

export function buildCanonicalScanSourceKey(cardImageId: string, sourceKeyOrUrl?: string | null): string {
  const extension = extractImageExtension(sourceKeyOrUrl);
  return `card-images/${cardImageId}/scan_source/scan-source${extension}`;
}

export async function copyScanSourceToCanonicalLocation(
  cardImageId: string,
  sourceKey: string,
): Promise<{ storageKey: string; publicUrl: string }> {
  const s3 = getScanIngestS3Config();
  const destinationKey = buildCanonicalScanSourceKey(cardImageId, sourceKey);

  if (sourceKey !== destinationKey) {
    await getS3Client(s3.region).send(new CopyObjectCommand({
      Bucket: s3.bucket,
      CopySource: `${s3.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
      Key: destinationKey,
      MetadataDirective: "COPY",
    }));
  }

  return {
    storageKey: destinationKey,
    publicUrl: buildPublicUrl(s3.publicBaseUrl, destinationKey),
  };
}
