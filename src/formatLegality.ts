export function formatBlockIsLegalSql(alias: string): string {
  return `(${alias}.rotated_at IS NULL OR ${alias}.rotated_at > CURRENT_TIMESTAMP)`;
}

export function formatBlockAllowedSql(blockAlias: string, formatAlias: string): string {
  return `(COALESCE(${formatAlias}.has_rotation, true) = false OR ${formatBlockIsLegalSql(blockAlias)})`;
}

export function formatBlocklessExceptionSql(cardBlockAlias: string, formatAlias: string): string {
  return `(UPPER(COALESCE(${cardBlockAlias}, '')) = 'X' AND COALESCE(${formatAlias}.has_rotation, true) = true)`;
}

export function formatCardBlockLegalSql(
  cardBlockAlias: string,
  blockAlias: string,
  formatAlias: string,
): string {
  return `(${formatBlocklessExceptionSql(cardBlockAlias, formatAlias)} OR (${blockAlias}.block IS NOT NULL AND ${blockAlias}.block = ${cardBlockAlias} AND ${formatBlockAllowedSql(blockAlias, formatAlias)}))`;
}

export function deriveFormatBlockLegal(rotatedAt: string | null, now: Date = new Date()): boolean {
  if (!rotatedAt) return true;

  const parsed = new Date(rotatedAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("rotated_at must be a valid date");
  }

  return parsed.getTime() > now.getTime();
}

export function resolveFormatBlockRotationInput(
  body: { legal?: unknown; rotated_at?: unknown },
  now: Date = new Date(),
): { legal: boolean; rotatedAt: string | null } {
  const rotatedAtValue = body.rotated_at == null ? null : String(body.rotated_at).trim();
  if (rotatedAtValue && Number.isNaN(Date.parse(rotatedAtValue))) {
    throw new Error("rotated_at must be a valid date");
  }

  const rotatedAt = rotatedAtValue || (body.legal === false ? now.toISOString() : null);
  return {
    legal: deriveFormatBlockLegal(rotatedAt, now),
    rotatedAt,
  };
}
