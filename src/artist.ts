import { bestArtistSubquery } from "./format.js";

export function artistSortSql(unique: string): string {
  return unique === "prints" ? "ci.artist" : bestArtistSubquery("c.id");
}

export function artistFilterSql(pattern: string, unique: string): string {
  if (unique === "prints") return `ci.artist ILIKE ${pattern}`;
  return `EXISTS (
    SELECT 1 FROM card_images ci_artist
    WHERE ci_artist.card_id = c.id
      AND ci_artist.artist ILIKE ${pattern}
  )`;
}

export function normalizedArtistFilterSql(pattern: string, unique: string): string {
  if (unique === "prints") {
    return `regexp_replace(lower(COALESCE(ci.artist, '')), '[^a-z0-9]+', '', 'g') LIKE ${pattern}`;
  }
  return `EXISTS (
    SELECT 1 FROM card_images ci_artist
    WHERE ci_artist.card_id = c.id
      AND regexp_replace(lower(COALESCE(ci_artist.artist, '')), '[^a-z0-9]+', '', 'g') LIKE ${pattern}
  )`;
}
