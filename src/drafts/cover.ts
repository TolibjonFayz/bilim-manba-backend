/**
 * Maqolaga muqova rasmi: faqat Wikimedia Commons'dagi erkin litsenziyali
 * rasmlar (Public domain, CC0, CC BY, CC BY-SA). Wikipedia'dagi "fair use"
 * rasmlar (film afishalari, logotiplar) Commons'da bo'lmaydi — ular o'tib ketadi.
 * Muallif va litsenziya maqolaning "Manbalar" bo'limida ko'rsatiladi.
 */

const UA = 'BilimManba/1.0 (https://bilimmanba.uz)';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';

export interface Cover {
  /** 1600px kenglikdagi nusxa (yuklab olish uchun) */
  imageUrl: string;
  /** Commons'dagi fayl sahifasi */
  pageUrl: string;
  title: string;
  artist: string;
  license: string;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Commons HTTP ${res.status}`);
  return res.json();
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

// NC (tijoriy emas) va ND (o'zgartirmaslik) litsenziyalari mos emas
const FREE = /^(cc0|public domain|pd\b|pd-|cc by(-sa)? \d)/i;
const NOT_FREE = /\b(nc|nd)\b|non-?commercial|fair use|non-free/i;

/** Wikipedia maqolalarining asosiy rasmlari (fayl nomlari) */
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
  // Asl tartibda (asosiy maqola birinchi)
  return titles
    .map((t) => byTitle.get(t))
    .filter((x): x is string => Boolean(x));
}

/** Commons'da mavzu bo'yicha rasmlar */
async function searchCommons(query: string): Promise<string[]> {
  const j = await getJson(
    q(COMMONS, {
      action: 'query',
      list: 'search',
      srnamespace: '6',
      srsearch: `${query} filetype:bitmap`,
      srlimit: '12',
    }),
  );
  return (j?.query?.search ?? []).map((r: any) =>
    String(r.title).replace(/^File:/, ''),
  );
}

async function fileInfos(names: string[]) {
  if (!names.length) return [];
  const j = await getJson(
    q(COMMONS, {
      action: 'query',
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: '1600',
      iiextmetadatafilter: 'LicenseShortName|Artist|Credit',
      titles: names.map((n) => `File:${n}`).join('|'),
    }),
  );
  const pages: any[] = j?.query?.pages ?? [];
  // Javob tartibi so'rovdagidan farq qiladi — nom bo'yicha qaytaramiz
  const norm = (s: string) => s.replace(/_/g, ' ').replace(/^File:/, '');
  return names.map((n) => {
    const p = pages.find((x) => norm(x.title) === norm(n));
    const info = p?.imageinfo?.[0];
    return info && !p.missing ? { title: p.title as string, info } : null;
  });
}

function toCover(f: { title: string; info: any } | null): Cover | null {
  if (!f) return null;
  const { info } = f;
  const meta = info.extmetadata ?? {};
  const license = stripHtml(meta.LicenseShortName?.value);
  if (!FREE.test(license) || NOT_FREE.test(license)) return null;
  if (!/^image\/(jpeg|png|webp)$/.test(info.mime)) return null;
  // Muqova uchun: yetarlicha katta va gorizontal (yoki kvadratga yaqin)
  const ratio = info.width / info.height;
  if (info.width < 1000 || ratio < 1.1 || ratio > 2.6) return null;
  return {
    imageUrl: info.thumburl ?? info.url,
    pageUrl: info.descriptionurl,
    title: f.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
    artist: stripHtml(meta.Artist?.value).slice(0, 100) || "Noma'lum muallif",
    license,
  };
}

/**
 * Avval manba maqolalarining o'z rasmlari (eng mos), keyin Commons qidiruvi.
 */
export async function findCover(
  lang: string,
  wikiTitles: string[],
  query: string,
): Promise<Cover | null> {
  const fromPages = await pageImages(lang, wikiTitles).catch(() => []);
  for (const cover of (await fileInfos(fromPages)).map(toCover)) {
    if (cover) return cover;
  }
  const found = await searchCommons(query).catch(() => []);
  for (const cover of (await fileInfos(found)).map(toCover)) {
    if (cover) return cover;
  }
  return null;
}

export async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Rasm yuklanmadi: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
