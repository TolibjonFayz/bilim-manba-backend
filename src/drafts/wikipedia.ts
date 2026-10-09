/**
 * Wikipedia'dan manba matnini olish. Matn CC BY-SA 4.0 litsenziyasida —
 * undan tayyorlangan maqolada manba havolasi va litsenziya ko'rsatiladi.
 */

// Wikimedia API'lari User-Agent talab qiladi
const UA = 'BilimManba/1.0 (https://bilimmanba.uz)';
// Groq bepul tarifi: so'rov (kirish + max javob) daqiqasiga ~8000 token
const MAX_EXTRACT = 7000;

export interface WikiSource {
  lang: string;
  title: string;
  url: string;
  text: string;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  return res.json();
}

const api = (lang: string, params: Record<string, string>) =>
  `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({
    format: 'json',
    formatversion: '2',
    origin: '*',
    ...params,
  })}`;

/** "https://en.wikipedia.org/wiki/Black_hole" → { lang: 'en', title: 'Black hole' } */
export function parseWikiUrl(input: string) {
  const m = input
    .trim()
    .match(/^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
  if (!m) return null;
  return {
    lang: m[1].toLowerCase(),
    title: decodeURIComponent(m[2]).replace(/_/g, ' '),
  };
}

async function search(lang: string, query: string): Promise<string | null> {
  const j = await getJson(
    api(lang, {
      action: 'query',
      list: 'search',
      srsearch: query,
      srlimit: '1',
      srnamespace: '0',
    }),
  );
  return j?.query?.search?.[0]?.title ?? null;
}

/** uz maqolaning inglizcha nusxasi (to'liqroq bo'ladi) */
async function englishTitle(lang: string, title: string) {
  const j = await getJson(
    api(lang, {
      action: 'query',
      prop: 'langlinks',
      lllang: 'en',
      titles: title,
      redirects: '1',
    }),
  );
  return (j?.query?.pages?.[0]?.langlinks?.[0]?.title as string) ?? null;
}

export async function fetchArticle(
  lang: string,
  title: string,
): Promise<WikiSource> {
  const j = await getJson(
    api(lang, {
      action: 'query',
      prop: 'extracts|info',
      explaintext: '1',
      exsectionformat: 'plain',
      inprop: 'url',
      redirects: '1',
      titles: title,
    }),
  );
  const page = j?.query?.pages?.[0];
  const text = String(page?.extract ?? '').trim();
  if (!page || page.missing || text.length < 300) {
    throw new Error(`Wikipedia'da "${title}" bo'yicha yetarli matn topilmadi`);
  }
  // "Manbalar", "Havolalar" kabi oxirgi bo'limlar kerak emas
  const cut = text.search(
    /\n(See also|References|Notes|External links|Further reading|Manbalar|Havolalar|Adabiyotlar)\n/,
  );
  return {
    lang,
    title: page.title,
    url: page.fullurl,
    text: (cut > 0 ? text.slice(0, cut) : text).slice(0, MAX_EXTRACT),
  };
}

/**
 * Mavzu (o'zbekcha yoki inglizcha so'z) yoki Wikipedia havolasidan manba topadi.
 * Avval inglizcha Wikipedia (eng to'liq), topilmasa — o'zbekcha.
 */
export async function findSource(topic: string): Promise<WikiSource> {
  const link = parseWikiUrl(topic);
  if (link) return fetchArticle(link.lang, link.title);

  const en = await search('en', topic);
  if (en) return fetchArticle('en', en);

  const uz = await search('uz', topic);
  if (uz) {
    const enTitle = await englishTitle('uz', uz).catch(() => null);
    return enTitle ? fetchArticle('en', enTitle) : fetchArticle('uz', uz);
  }
  throw new Error(`"${topic}" mavzusi Wikipedia'dan topilmadi`);
}

/** Inglizcha Wikipedia'ning bugungi tanlangan maqolasi (Today's featured article) */
export async function featuredToday(date = new Date()): Promise<WikiSource> {
  const [y, m, d] = date.toISOString().slice(0, 10).split('-');
  const j = await getJson(
    `https://en.wikipedia.org/api/rest_v1/feed/featured/${y}/${m}/${d}`,
  );
  const title = j?.tfa?.titles?.normalized ?? j?.tfa?.title;
  if (!title) throw new Error('Bugungi tanlangan maqola topilmadi');
  return fetchArticle('en', title);
}
