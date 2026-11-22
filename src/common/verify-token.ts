import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Email tasdiqlash havolasi uchun imzolangan token (bazada saqlanmaydi):
 *   <userId>.<amal qilish muddati, ms>.<imzo>
 * Imzo email bilan bog'langan — email o'zgarsa eski havola ishlamaydi.
 */
export const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const secretKey = () => process.env.JWT_SECRET || '';
const norm = (email: string) =>
  String(email ?? '')
    .trim()
    .toLowerCase();

const sign = (userId: number, exp: number, email: string) =>
  createHmac('sha256', `verify-email:${secretKey()}`)
    .update(`${userId}.${exp}.${norm(email)}`)
    .digest('hex')
    .slice(0, 40);

export function makeVerifyToken(
  userId: number,
  email: string,
  now = Date.now(),
): string {
  const exp = now + VERIFY_TTL_MS;
  return `${userId}.${exp}.${sign(userId, exp, email)}`;
}

/** Token tarkibi (imzosi hali tekshirilmagan) yoki null */
export function parseVerifyToken(token: unknown) {
  const m = /^(\d{1,10})\.(\d{10,15})\.([a-f0-9]{40})$/.exec(
    String(token ?? ''),
  );
  return m ? { userId: Number(m[1]), exp: Number(m[2]), sig: m[3] } : null;
}

/** Imzo va muddatni tekshiradi (email — bazadagi joriy email) */
export function checkVerifyToken(
  token: unknown,
  email: string,
  now = Date.now(),
): boolean {
  const t = parseVerifyToken(token);
  if (!t || !secretKey() || t.exp < now) return false;
  const expected = Buffer.from(sign(t.userId, t.exp, email));
  const given = Buffer.from(t.sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function verifyEmailUrl(userId: number, email: string): string {
  const site = (process.env.SITE_URL ?? 'https://bilimmanba.uz').replace(
    /\/$/,
    '',
  );
  return `${site}/verify-email?token=${makeVerifyToken(userId, email)}`;
}
