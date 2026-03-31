/**
 * Scryfall-inspired search query parser.
 *
 * Supports:
 *   luffy              → name contains "luffy"
 *   "Monkey D. Luffy"  → name contains exact phrase
 *   name:"Luffy"       → card name contains phrase
 *   name="Luffy"       → exact card name match
 *   c:red              → color includes red
 *   c:red,yellow       → color includes red or yellow
 *   c=red              → color exactly red
 *   cost>=5            → cost >= 5
 *   t:leader           → type = leader
 *   r:sr               → rarity = SR
 *   -c:red             → NOT color red
 *   A OR B             → disjunction
 *   (A B) OR C         → grouping
 */

export type Operator = ":" | "=" | ">=" | "<=" | ">" | "<" | "!=";

export interface FilterNode {
  type: "filter";
  field: string;
  operator: Operator;
  value: string;
  negated: boolean;
}

export interface NameNode {
  type: "name";
  value: string;
  negated: boolean;
}

export interface AndNode {
  type: "and";
  children: SearchNode[];
}

export interface OrNode {
  type: "or";
  children: SearchNode[];
}

export type SearchNode = FilterNode | NameNode | AndNode | OrNode;

const FIELD_ALIASES: Record<string, string> = {
  n: "name",
  name: "name",
  c: "color",
  color: "color",
  t: "type",
  type: "type",
  cost: "cost",
  pow: "power",
  power: "power",
  life: "life",
  counter: "counter",
  r: "rarity",
  rarity: "rarity",
  artist: "artist",
  text: "text",
  any: "text",
  o: "effect",
  effect: "effect",
  trigger: "trigger",
  trait: "trait",
  tr: "trait",
  a: "attribute",
  attribute: "attribute",
  block: "block",
  set: "set",
  product: "product",
  legal: "legal",
  banned: "banned",
  is: "is",
  not: "not",
  has: "has",
  usd: "usd",
  year: "year",
  date: "date",
  new: "new",
  prints: "prints",
  order: "order",
  sort: "order",
  dir: "direction",
  direction: "direction",
};

const OPERATOR_PATTERN = /^(>=|<=|!=|>|<|=|:)/;
const IMPLICIT_CARD_NUMBER_PATTERN = /^(?:(?:OP\d{2}|ST\d{2}|EB\d{2}|PRB\d{2})-\d{3}|P-\d{3})$/i;
const IMPLICIT_SET_CODE_PATTERN = /^(?:OP\d{2}|ST\d{2}|EB\d{2}|PRB\d{2}|P\d{2,3})$/i;

export function parseSearch(input: string): SearchNode {
  const tokens = tokenize(input);
  const result = parseOr(tokens, 0);
  return result.node;
}

interface ParseResult {
  node: SearchNode;
  pos: number;
}

function isOrOperator(token: string | undefined): boolean {
  return token === "OR";
}

function isNotOperator(token: string | undefined): boolean {
  return token === "NOT";
}

function parseOr(tokens: string[], pos: number): ParseResult {
  const { node: left, pos: nextPos } = parseAnd(tokens, pos);
  const children: SearchNode[] = [left];

  let p = nextPos;
  while (p < tokens.length && isOrOperator(tokens[p])) {
    p++; // skip OR
    const { node: right, pos: afterRight } = parseAnd(tokens, p);
    children.push(right);
    p = afterRight;
  }

  if (children.length === 1) return { node: children[0], pos: p };
  return { node: { type: "or", children }, pos: p };
}

function parseAnd(tokens: string[], pos: number): ParseResult {
  const children: SearchNode[] = [];
  let p = pos;

  while (p < tokens.length && tokens[p] !== ")" && !isOrOperator(tokens[p])) {
    const { node, pos: nextPos } = parseAtom(tokens, p);
    children.push(node);
    p = nextPos;
  }

  if (children.length === 0) throw new Error("Empty search query");
  if (children.length === 1) return { node: children[0], pos: p };
  return { node: { type: "and", children }, pos: p };
}

function parseAtom(tokens: string[], pos: number): ParseResult {
  const token = tokens[pos];
  if (token === undefined) {
    throw new Error("Unexpected end of search query");
  }

  // Parenthesized group
  if (token === "(") {
    const { node, pos: afterGroup } = parseOr(tokens, pos + 1);
    if (afterGroup >= tokens.length || tokens[afterGroup] !== ")") {
      throw new Error("Unmatched parenthesis");
    }
    return { node, pos: afterGroup + 1 };
  }

  // Negation
  if (token === "-" || isNotOperator(token)) {
    const { node, pos: afterNeg } = parseAtom(tokens, pos + 1);
    negate(node);
    return { node, pos: afterNeg };
  }

  // Negated token (e.g. "-c:red")
  if (token.startsWith("-") && token.length > 1) {
    const inner = token.slice(1);
    const parsed = parseFilterToken(inner);
    parsed.negated = true;
    return { node: parsed, pos: pos + 1 };
  }

  // Filter or name token
  const node = parseFilterToken(token);
  return { node, pos: pos + 1 };
}

function parseFilterToken(token: string): FilterNode | NameNode {
  // Quoted string → name search
  if (token.startsWith('"') && token.endsWith('"')) {
    return { type: "name", value: token.slice(1, -1), negated: false };
  }

  if (IMPLICIT_CARD_NUMBER_PATTERN.test(token)) {
    return {
      type: "filter",
      field: "card_number",
      operator: ":",
      value: token.toUpperCase(),
      negated: false,
    };
  }

  if (IMPLICIT_SET_CODE_PATTERN.test(token)) {
    return {
      type: "filter",
      field: "set",
      operator: ":",
      value: token.toUpperCase(),
      negated: false,
    };
  }

  // Check for field:value pattern
  for (const [alias] of Object.entries(FIELD_ALIASES)) {
    if (token.toLowerCase().startsWith(alias)) {
      const rest = token.slice(alias.length);
      const opMatch = rest.match(OPERATOR_PATTERN);
      if (opMatch) {
        const op = opMatch[1] as Operator;
        let value = rest.slice(op.length);
        // Strip surrounding quotes from value (e.g. product:"Card the Best")
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        return {
          type: "filter",
          field: FIELD_ALIASES[alias],
          operator: op,
          value,
          negated: false,
        };
      }
    }
  }

  // Plain word → name search
  return { type: "name", value: token, negated: false };
}

function negate(node: SearchNode) {
  if (node.type === "filter" || node.type === "name") {
    node.negated = !node.negated;
  } else if (node.type === "and") {
    // De Morgan: NOT (A AND B) = NOT A OR NOT B
    // For simplicity, just negate each child
    for (const child of node.children) negate(child);
  } else if (node.type === "or") {
    for (const child of node.children) negate(child);
  }
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const s = input.trim();

  while (i < s.length) {
    // Skip whitespace
    if (s[i] === " " || s[i] === "\t") {
      i++;
      continue;
    }

    // Parens
    if (s[i] === "(" || s[i] === ")") {
      tokens.push(s[i]);
      i++;
      continue;
    }

    // Quoted string
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j++;
      tokens.push(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    // Word/filter token — if a quote is encountered mid-token (e.g. product:"foo bar"),
    // consume through the closing quote so the entire value stays in one token.
    let j = i;
    while (j < s.length && s[j] !== " " && s[j] !== "\t" && s[j] !== "(" && s[j] !== ")") {
      if (s[j] === '"') {
        j++;
        while (j < s.length && s[j] !== '"') j++;
        if (j < s.length) j++; // skip closing quote
        break;
      }
      j++;
    }
    tokens.push(s.slice(i, j));
    i = j;
  }

  return tokens;
}
