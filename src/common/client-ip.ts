/**
 * Mijozning haqiqiy IP manzili. Render Cloudflare ortida turadi — req.ip
 * proxy manzilini beradi, shuning uchun sarlavhalardan olamiz
 * (cf-connecting-ip ni Cloudflare o'zi yozadi, mijoz soxtalashtira olmaydi).
 */
export function clientIp(req: any): string {
  const h = req?.headers ?? {};
  const xff = String(h['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ip =
    h['cf-connecting-ip'] ??
    h['true-client-ip'] ??
    xff[xff.length - 1] ??
    req?.ip ??
    'unknown';
  return String(Array.isArray(ip) ? ip[0] : ip).slice(0, 64);
}
