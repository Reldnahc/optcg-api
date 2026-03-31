const COLOR_MAP: Record<string, string> = {
  red: "Red",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  black: "Black",
  yellow: "Yellow",
};

export function normalizeColorFilter(value: string): string[] {
  return [...new Set(
    value
      .split(",")
      .map((color) => COLOR_MAP[color.trim().toLowerCase()])
      .filter((color): color is string => Boolean(color)),
  )];
}

export function toPgTextArrayLiteral(values: string[]): string {
  return `{${values.join(",")}}`;
}
