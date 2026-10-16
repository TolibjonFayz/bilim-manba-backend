/**
 * Muqova rasmi uchun nomzodlar — faqat erkin foydalanish mumkin bo'lgan
 * rasmlar (internetdagi oddiy rasmlar mualliflik huquqi bilan himoyalangan):
 *  - Wikimedia Commons: manba maqolalarining asosiy rasmlari (PD, CC0, CC BY, CC BY-SA)
 *  - Openverse: Flickr, muzeylar va boshqa 800M+ erkin rasm (CC0, PD, CC BY, CC BY-SA)
 *  - NASA Image Library: AQSh hukumati ishi — mualliflik huquqisiz
 *  - Pexels (PEXELS_API_KEY bo'lsa): Pexels litsenziyasi, tijoriy foydalanish mumkin
 * Muallif va litsenziya maqolaning "Manbalar" bo'limida ko'rsatiladi.
 */

const UA = 'BilimManba/1.0 (https://bilimmanba.uz)';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';

export interface ImageCandidate {
  /** Katta nusxa (yuklab olish uchun) */
  imageUrl: string;
  /** Kichik nusxa (Gemini ko'rib tanlashi uchun) */
  thumbUrl: string;
  /** imageUrl yuklanmasa — zaxira nusxalar */
  altUrls?: string[];
  /**
   * Tahririyat nazoratidagi baza (Pexels, NASA) — 18+ rasm ehtimoli juda past.
   * AI rasmni ko'rib tekshira olmasa, faqat shulardan foydalaniladi.
   */
  trusted?: boolean;
  /** Rasm sahifasi (atributsiya havolasi) */
  pageUrl: string;
  title: string;
  artist: string;
  license: string;
  provider: string;
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${new URL(url).host})`);
  return res.json() as Promise<any>;
}

const q = (base: string, params: Record<string, string>) =>
  `${base}?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })}`;

const stripHtml = (s: string) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 18+ va shok mazmunli rasmlarni nomi, tavsifi, teglari yoki kategoriyasi
 * bo'yicha chiqarib tashlash. Commons/Openverse'da san'at asarlari, tibbiy
 * va tarixiy rasmlar orasida yalang'ochlik va zo'ravonlik uchraydi. Bu birinchi
 * qavat — keyin Gemini rasmning o'zini ko'rib tekshiradi.
 */
const UNSAFE =
  /\b(nudes?|nudity|naked|nakedness|topless|bare[- ]?breast\w*|breasts?|nipples?|erotic\w*|sex|sexual\w*|sexy|porn\w*|xxx|nsfw|lingerie|underwear|bikini|swimsuits?|genital\w*|penis|vagina|vulva|phall\w*|intercourse|orgy|fetish\w*|bdsm|bondage|strip(per|tease)|prostitut\w*|brothel|hentai|playboy|courtesan|odalisque|baigneuses?|bathers?|nu|nue|desnud[oa]s?|corpses?|cadavers?|autops\w*|gore|gory|behead\w*|decapitat\w*|mutilat\w*|lynch\w*|dismember\w*|suicide|cocaine|heroin|alcohol\w*|beers?|wines?|vodka|whiske?y|liquor|cocktails?|drunk\w*|casinos?|gambl\w*|satan\w*|occult\w*|pentagram\w*)\b|обнаж|эрот|голая|голый|порн|секс|yalang'och|erotik|jinsiy/i;

export function unsafeText(...parts: unknown[]): boolean {
  return UNSAFE.test(
    parts
      .flat()
      .map((x) => stripHtml(String(x ?? '')))
      .join(' | ')
      .replace(/[_-]+/g, ' '),
  );
}

// NC (tijoriy emas) va ND (o'zgartirmaslik) litsenziyalari mos emas
const FREE = /^(cc0|public domain|pd\b|pd-|cc by(-sa)? \d)/i;
const NOT_FREE = /\b(nc|nd)\b|non-?commercial|fair use|non-free/i;
// Muqova: yetarlicha katta va gorizontal (yoki kvadratga yaqin)
const goodShape = (w?: number, h?: number) =>
  !w || !h || (w >= 1000 && w / h >= 1.1 && w / h <= 2.6);

// ---------- Wikimedia Commons ----------

/**
 * Wikimedia rasmining kerakli kenglikdagi nusxasi. Wikimedia endi faqat
 * standart kengliklarni beradi (250, 500, 960, 1280, 1920 ...); asl rasm
 * so'ralganidan tor bo'lsa — aslini qaytaramiz.
 */
export function wikimediaSized(url: string, width: number, origWidth?: number) {
  const m = String(url).match(
    /upload\.wikimedia\.org\/wikipedia\/commons\/(?:thumb\/)?([0-9a-f])\/([0-9a-f]{2})\/([^/?]+)/,
  );
  if (!m || (origWidth && origWidth <= width)) return url;
  const [, a, ab, name] = m;
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${a}/${ab}/${name}/${width}px-${name}`;
}

/** Katta nusxa: 1920 yoki 1280px (yuklash tez, Cloudinary limitidan oshmaydi) */
const wikimediaBig = (url: string, w?: number) =>
  wikimediaSized(url, w && w >= 1920 ? 1920 : 1280, w);

async function pageImages(lang: string, titles: string[]): Promise<string[]> {
  if (!titles.length) return [];
  const j = await getJson(
    q(`https://${lang}.wikipedia.org/w/api.php`, {
      action: 'query',
      prop: 'pageimages',
      piprop: 'name',
      redirects: '1',
      titles: titles.join('|'),
    }),
  );
  const byTitle = new Map<string, string>(
    (j?.query?.pages ?? [])
      .filter((p: any) => p.pageimage)
      .map((p: any) => [p.title, p.pageimage]),
  );
  return titles
    .map((t) => byTitle.get(t))
    .filter((x): x is string => Boolean(x));
}

async function commonsFiles(names: string[]): Promise<ImageCandidate[]> {
  if (!names.length) return [];
  const j = await getJson(
    q(COMMONS, {
      action: 'query',
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: '1600',
      iiextmetadatafilter:
        'LicenseShortName|Artist|Categories|ImageDescription|ObjectName',
      titles: names.map((n) => `File:${n}`).join('|'),
    }),
  );
  const pages: any[] = j?.query?.pages ?? [];
  const norm = (s: string) => s.replace(/_/g, ' ').replace(/^File:/, '');
  const out: ImageCandidate[] = [];
  for (const n of names) {
    const p = pages.find((x) => norm(x.title) === norm(n));
    const info = p?.imageinfo?.[0];
    if (!info || p.missing) continue;
    const meta = info.extmetadata ?? {};
    const license = stripHtml(meta.LicenseShortName?.value);
    if (!FREE.test(license) || NOT_FREE.test(license)) continue;
    if (!/^image\/(jpeg|png|webp)$/.test(info.mime)) continue;
    if (!goodShape(info.width, info.height)) continue;
    // Nomi, tavsifi yoki Commons kategoriyalarida 18+/shok belgisi bo'lsa — o'tkazamiz
    if (
      unsafeText(
        p.title,
        meta.Categories?.value,
        meta.ImageDescription?.value,
        meta.ObjectName?.value,
      )
    )
      continue;
    out.push({
      imageUrl: wikimediaBig(info.url, info.width),
      thumbUrl: wikimediaSized(info.url, 500, info.width),
      pageUrl: info.descriptionurl,
      title: p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
      artist: stripHtml(meta.Artist?.value).slice(0, 100) || "Noma'lum muallif",
      license,
      provider: 'Wikimedia Commons',
    });
  }
  return out;
}

/** Manba maqolalarining o'z rasmlari — odatda eng aniq mos keladi */
export async function commonsCandidates(
  lang: string,
  wikiTitles: string[],
): Promise<ImageCandidate[]> {
  return commonsFiles(await pageImages(lang, wikiTitles));
}

// ---------- Openverse ----------

const OV_LICENSE: Record<string, string> = {
  cc0: 'CC0',
  pdm: 'Public domain',
  by: 'CC BY',
  'by-sa': 'CC BY-SA',
};

export async function openverseCandidates(
  query: string,
  max = 5,
): Promise<ImageCandidate[]> {
  const j = await getJson(
    `https://api.openverse.org/v1/images/?${new URLSearchParams({
      q: query,
      license: 'cc0,pdm,by,by-sa',
      aspect_ratio: 'wide',
      size: 'large',
      mature: 'false',
      page_size: '12',
    })}`,
  );
  return (j?.results ?? [])
    .filter(
      (r: any) =>
        OV_LICENSE[r.license] &&
        goodShape(r.width, r.height) &&
        // Manba "mature" deb belgilagan yoki nomi/teglarida 18+ belgisi bo'lsa — yo'q
        !r.mature &&
        !unsafeText(
          r.title,
          (r.tags ?? []).map((t: any) => t?.name),
        ) &&
        // TIFF/SVG'ning Wikimedia nusxalari boshqa manzilda — JPG/PNG yetarli
        (!r.filetype || /^(jpe?g|png|webp)$/i.test(r.filetype)),
    )
    .slice(0, max)
    .map(
      (r: any): ImageCandidate => ({
        // Openverse'ning o'z kichik nusxa xizmati katta rasmlarda 424 beradi —
        // Wikimedia rasmlari uchun Wikimedia'ning standart nusxalarini olamiz
        imageUrl: wikimediaBig(r.url, r.width),
        thumbUrl: /upload\.wikimedia\.org/.test(r.url)
          ? wikimediaSized(r.url, 500, r.width)
          : (r.thumbnail ?? r.url),
        pageUrl: r.foreign_landing_url ?? r.url,
        title: stripHtml(r.title).slice(0, 120) || query,
        artist: stripHtml(r.creator).slice(0, 100) || "Noma'lum muallif",
        license: `${OV_LICENSE[r.license]}${r.license_version && r.license !== 'pdm' ? ` ${r.license_version}` : ''}`,
        provider: r.source ? `Openverse (${r.source})` : 'Openverse',
      }),
    );
}

// ---------- NASA ----------

export async function nasaCandidates(
  query: string,
  max = 3,
): Promise<ImageCandidate[]> {
  const j = await getJson(
    `https://images-api.nasa.gov/search?${new URLSearchParams({
      q: query,
      media_type: 'image',
      page_size: '6',
    })}`,
  );
  return (j?.collection?.items ?? [])
    .slice(0, max)
    .map((it: any): ImageCandidate | null => {
      const d = it?.data?.[0];
      const thumb = it?.links?.[0]?.href as string | undefined;
      if (!d?.nasa_id || !thumb) return null;
      if (unsafeText(d.title, d.description, d.keywords)) return null;
      const id = encodeURIComponent(d.nasa_id);
      return {
        // "~large" nusxa deyarli har doim bor; bo'lmasa yuklashda o'tib ketadi
        imageUrl: `https://images-assets.nasa.gov/image/${id}/${id}~large.jpg`,
        altUrls: [
          `https://images-assets.nasa.gov/image/${id}/${id}~orig.jpg`,
          `https://images-assets.nasa.gov/image/${id}/${id}~medium.jpg`,
        ],
        thumbUrl: thumb,
        pageUrl: `https://images.nasa.gov/details/${id}`,
        title: stripHtml(d.title).slice(0, 120),
        artist: d.center ? `NASA/${d.center}` : 'NASA',
        license: 'Public domain (NASA)',
        provider: 'NASA Image Library',
        trusted: true,
      };
    })
    .filter((x): x is ImageCandidate => Boolean(x));
}

// ---------- Pexels (ixtiyoriy) ----------

export async function pexelsCandidates(
  query: string,
  apiKey: string,
  max = 4,
): Promise<ImageCandidate[]> {
  const j = await getJson(
    `https://api.pexels.com/v1/search?${new URLSearchParams({
      query,
      orientation: 'landscape',
      per_page: String(max),
    })}`,
    { Authorization: apiKey },
  );
  return (j?.photos ?? [])
    .filter((p: any) => !unsafeText(p.alt))
    .map(
      (p: any): ImageCandidate => ({
        imageUrl: p.src?.large2x ?? p.src?.original,
        thumbUrl: p.src?.medium ?? p.src?.small,
        pageUrl: p.url,
        title: stripHtml(p.alt).slice(0, 120) || query,
        artist: p.photographer || 'Pexels',
        license: 'Pexels License',
        provider: 'Pexels',
        trusted: true,
      }),
    );
}

export async function downloadImage(url: string, maxBytes = 30_000_000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Rasm yuklanmadi: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error('Rasm juda katta');
  return Buffer.from(await res.arrayBuffer());
}
