import { query } from "optcg-db/db/client.js";
import { bestImageFieldSubquery } from "./format.js";

let hasCardImageArtistPromise: Promise<boolean> | null = null;

export async function hasCardImageArtistColumn(): Promise<boolean> {
  if (!hasCardImageArtistPromise) {
    hasCardImageArtistPromise = (async () => {
      const result = await query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_name = 'card_images'
             AND column_name = 'artist'
         ) AS exists`,
      );
      return Boolean(result.rows[0]?.exists);
    })();
  }

  return hasCardImageArtistPromise;
}

export function artistSortSql(unique: string, hasImageArtist: boolean): string {
  if (!hasImageArtist) return "c.artist";
  return unique === "prints" ? "ci.artist" : bestImageFieldSubquery("c.id", "artist");
}

export function artistFilterSql(pattern: string, unique: string, hasImageArtist: boolean): string {
  if (!hasImageArtist) return `c.artist ILIKE ${pattern}`;
  if (unique === "prints") return `ci.artist ILIKE ${pattern}`;
  return `EXISTS (
    SELECT 1 FROM card_images ci_artist
    WHERE ci_artist.card_id = c.id
      AND ci_artist.classified = true
      AND ci_artist.artist ILIKE ${pattern}
  )`;
}

export function normalizedArtistFilterSql(pattern: string, unique: string, hasImageArtist: boolean): string {
  if (!hasImageArtist) {
    return `regexp_replace(lower(COALESCE(c.artist, '')), '[^a-z0-9]+', '', 'g') LIKE ${pattern}`;
  }
  if (unique === "prints") {
    return `regexp_replace(lower(COALESCE(ci.artist, '')), '[^a-z0-9]+', '', 'g') LIKE ${pattern}`;
  }
  return `EXISTS (
    SELECT 1 FROM card_images ci_artist
    WHERE ci_artist.card_id = c.id
      AND ci_artist.classified = true
      AND regexp_replace(lower(COALESCE(ci_artist.artist, '')), '[^a-z0-9]+', '', 'g') LIKE ${pattern}
  )`;
}
