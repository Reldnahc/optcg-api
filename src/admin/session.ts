import crypto from "node:crypto";
import { getAdminEmail, getAdminPasswordHash, getAdminTokenTtlSeconds, getJwtSecret } from "./config.js";

export interface AdminTokenPayload {
  sub: string;
  iat: number;
  exp: number;
  scope: "admin";
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function sign(data: string): string {
  return crypto.createHmac("sha256", getJwtSecret()).update(data).digest("base64url");
}

function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(password: string, storedHash: string): boolean {
  if (storedHash.startsWith("plain$")) {
    return timingSafeEqualText(password, storedHash.slice("plain$".length));
  }

  if (storedHash.startsWith("sha256$")) {
    const digest = crypto.createHash("sha256").update(password).digest("hex");
    return timingSafeEqualText(digest, storedHash.slice("sha256$".length));
  }

  if (storedHash.startsWith("scrypt$")) {
    const parts = storedHash.split("$");
    if (parts.length !== 3) throw new Error("Invalid scrypt password hash format");
    const [, salt, expectedHex] = parts;
    const expected = Buffer.from(expectedHex, "hex");
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  }

  throw new Error("Unsupported ADMIN_PASSWORD_HASH format; use plain$, sha256$, or scrypt$");
}

export function verifyAdminCredentials(email: string, password: string): boolean {
  if (!timingSafeEqualText(email.trim().toLowerCase(), getAdminEmail().trim().toLowerCase())) {
    return false;
  }
  return verifyPassword(password, getAdminPasswordHash());
}

export function signAdminToken(email: string): { token: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const payload: AdminTokenPayload = {
    sub: email,
    iat: now,
    exp: now + getAdminTokenTtlSeconds(),
    scope: "admin",
  };
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(`${encodedHeader}.${encodedPayload}`);

  return {
    token: `${encodedHeader}.${encodedPayload}.${signature}`,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

export function verifyAdminToken(token: string): AdminTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");

  const [encodedHeader, encodedPayload, receivedSignature] = parts;
  const expectedSignature = sign(`${encodedHeader}.${encodedPayload}`);
  if (!timingSafeEqualText(receivedSignature, expectedSignature)) {
    throw new Error("Invalid token signature");
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as AdminTokenPayload;
  if (payload.scope !== "admin") throw new Error("Invalid token scope");
  if (payload.exp <= Math.floor(Date.now() / 1000)) throw new Error("Token expired");
  return payload;
}
