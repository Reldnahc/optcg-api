const COLOR_MAP: Record<string, string> = {
  red: "Red",
  r: "Red",
  green: "Green",
  g: "Green",
  blue: "Blue",
  u: "Blue",
  purple: "Purple",
  p: "Purple",
  black: "Black",
  b: "Black",
  yellow: "Yellow",
  y: "Yellow",
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
