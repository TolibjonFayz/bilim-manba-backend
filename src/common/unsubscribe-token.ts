import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Obunani bekor qilish havolasi uchun imzo: emailni bilgan har kim
 * birovning obunasini o'chirib yubormasin. Imzo faqat serverda yasaladi
 * va xatdagi havolaga qo'shiladi.
 */
const normalize = (email: string) => String(email ?? '').trim().toLowerCase();

const secretKey = () =>
  process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || '';

export function unsubscribeToken(email: string): string {
  const secret = secretKey();
  return createHmac('sha256', `unsubscribe:${secret}`)
    .update(normalize(email))
    .digest('hex')
    .slice(0, 40);
}

export function checkUnsubscribeToken(email: string, token: unknown): boolean {
  // Maxfiy kalit sozlanmagan bo'lsa imzoni har kim yasay olardi — rad etamiz
  if (typeof token !== 'string' || !email || !secretKey()) return false;
  const expected = Buffer.from(unsubscribeToken(email));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function unsubscribeUrl(email: string): string {
  const site = (process.env.SITE_URL ?? 'https://bilimmanba.uz').replace(/\/$/, '');
  return `${site}/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;
}
