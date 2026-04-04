import { query } from "optcg-db/db/client.js";

type CardImageAssetRole =
  | "image_url"
  | "image_thumb"
  | "scan_source"
  | "scan_url"
  | "scan_thumb"
  | "scan_display";

interface CardImageAssetSyncInput {
  cardImageId: string;
  role: CardImageAssetRole;
  storageKey?: string | null;
  publicUrl?: string | null;
  sourceUrl?: string | null;
}

function normalizeAssetValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function syncCardImageAsset(input: CardImageAssetSyncInput): Promise<void> {
  const storageKey = normalizeAssetValue(input.storageKey);
  const publicUrl = normalizeAssetValue(input.publicUrl);
  const sourceUrl = normalizeAssetValue(input.sourceUrl);

  if (!storageKey && !publicUrl && !sourceUrl) {
    await query(
      `DELETE FROM card_image_assets
       WHERE card_image_id = $1
         AND role = $2`,
      [input.cardImageId, input.role],
    );
    return;
  }

  await query(
    `INSERT INTO card_image_assets (
       card_image_id,
       role,
       storage_key,
       public_url,
       source_url
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (card_image_id, role) DO UPDATE
     SET storage_key = EXCLUDED.storage_key,
         public_url = EXCLUDED.public_url,
         source_url = EXCLUDED.source_url,
         updated_at = NOW()`,
    [input.cardImageId, input.role, storageKey, publicUrl, sourceUrl],
  );
}

