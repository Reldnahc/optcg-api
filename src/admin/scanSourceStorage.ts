import { CopyObjectCommand } from "@aws-sdk/client-s3";
import {
  buildPublicUrl,
  extractImageExtension,
  getS3Client,
  getStorageConfig,
  scanSourceKey,
} from "../storage.js";

export function buildCanonicalScanSourceKey(
  cardNumber: string,
  language: string,
  variantIndex: number,
  sourceKeyOrUrl?: string | null,
): string {
  const extension = extractImageExtension(sourceKeyOrUrl);
  return scanSourceKey(cardNumber, language, variantIndex, extension);
}

/**
 * Copy a freshly-uploaded scan to the canonical card-keyed location.
 * Caller passes (card_number, language, variant_index) — these are always
 * available at the link site (the user is explicitly assigning the scan to
 * a card variant).
 */
export async function copyScanSourceToCanonicalLocation(
  cardNumber: string,
  language: string,
  variantIndex: number,
  sourceKey: string,
): Promise<{ storageKey: string; publicUrl: string }> {
  const cfg = getStorageConfig();
  const destinationKey = buildCanonicalScanSourceKey(cardNumber, language, variantIndex, sourceKey);

  if (sourceKey !== destinationKey) {
    await getS3Client().send(new CopyObjectCommand({
      Bucket: cfg.bucket,
      CopySource: `${cfg.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
      Key: destinationKey,
      MetadataDirective: "COPY",
    }));
  }

  return {
    storageKey: destinationKey,
    publicUrl: buildPublicUrl(destinationKey),
  };
}
