import { createPublicKey, verify, KeyObject } from 'crypto';

/**
 * "Google bilan kirish": brauzer Google'dan olgan ID token (JWT, RS256)
 * shu yerda tekshiriladi — imzo Google kalitlari bilan, auditoriya (aud)
 * bizning client ID, muddati o'tmagan, email Google tomonidan tasdiqlangan.
 * Qo'shimcha kutubxonasiz (node crypto).
 */
export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_S = 60;

let cache: { at: number; ttl: number; keys: Map<string, KeyObject> } | null =
  null;

type Fetcher = (url: string) => Promise<{ keys: any[]; maxAge?: number }>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Google kalitlari olinmadi: ${res.status}`);
  const maxAge = Number(
    /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1],
  );
  const json: any = await res.json();
  return { keys: json?.keys ?? [], maxAge: maxAge || 3600 };
};

async function googleKeys(fetcher: Fetcher, force = false) {
  if (!force && cache && Date.now() - cache.at < cache.ttl) return cache.keys;
  const { keys, maxAge } = await fetcher(CERTS_URL);
  const map = new Map<string, KeyObject>();
  for (const jwk of keys) {
    if (jwk?.kid && jwk?.kty === 'RSA') {
      map.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }
  }
  cache = { at: Date.now(), ttl: (maxAge ?? 3600) * 1000, keys: map };
  return map;
}

/** Testlar uchun */
export function resetGoogleKeyCache() {
  cache = null;
}

const b64json = (s: string) =>
  JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  fetcher: Fetcher = defaultFetcher,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<GoogleProfile> {
  if (typeof token !== 'string' || token.length > 4096) {
    throw new Error("Token noto'g'ri");
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error("Token noto'g'ri");
  const [h, p, s] = parts;
  let header: any, payload: any;
  try {
    header = b64json(h);
    payload = b64json(p);
  } catch {
    throw new Error("Token noto'g'ri");
  }
  if (header?.alg !== 'RS256' || !header?.kid) {
    throw new Error("Token algoritmi noto'g'ri");
  }
  let keys = await googleKeys(fetcher);
  // Google kalitlarni almashtirgan bo'lsa — bir marta yangilab ko'ramiz
  if (!keys.has(header.kid)) keys = await googleKeys(fetcher, true);
  const key = keys.get(header.kid);
  if (!key) throw new Error('Token kaliti topilmadi');

  const ok = verify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),
    key,
    Buffer.from(s, 'base64url'),
  );
  if (!ok) throw new Error('Token imzosi yaroqsiz');

  if (!ISSUERS.has(payload.iss)) throw new Error("Token beruvchi noto'g'ri");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!clientId || !aud.includes(clientId)) {
    throw new Error('Token boshqa ilova uchun berilgan');
  }
  if (!(Number(payload.exp) + CLOCK_SKEW_S > nowSec)) {
    throw new Error("Token muddati o'tgan");
  }
  if (payload.iat && Number(payload.iat) - CLOCK_SKEW_S > nowSec) {
    throw new Error("Token vaqti noto'g'ri");
  }
  const verified =
    payload.email_verified === true || payload.email_verified === 'true';
  if (!payload.email || !verified) {
    throw new Error('Google email manzili tasdiqlanmagan');
  }
  return {
    sub: String(payload.sub),
    email: String(payload.email).toLowerCase(),
    name: String(payload.name ?? payload.given_name ?? '').trim(),
    picture: payload.picture,
  };
}
