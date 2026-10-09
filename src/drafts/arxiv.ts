/**
 * arXiv'dagi ilmiy ishlarning annotatsiyalari. arXiv metama'lumotlari
 * (sarlavha, mualliflar, annotatsiya) CC0 — erkin foydalanish mumkin.
 * Maqolaga "yaqinda chiqqan tadqiqot" yangiligini beradi.
 */

export interface ArxivPaper {
  title: string;
  url: string;
  summary: string;
  published: string;
  authors: string[];
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const tag = (xml: string, name: string) =>
  decode(
    xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? '',
  );

/** Sarlavhasida mavzu bo'lgan, so'nggi 2 yildagi eng mos ishlar */
export async function searchArxiv(
  query: string,
  max = 3,
  now = new Date(),
): Promise<ArxivPaper[]> {
  const q = query
    .replace(/\(.*?\)/g, '')
    .replace(/["]/g, '')
    .trim();
  if (!q) return [];
  const from = new Date(now.getTime() - 2 * 365 * 24 * 3600 * 1000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const search = `ti:"${q}" AND submittedDate:[${ymd(from)}0000 TO ${ymd(now)}2359]`;
  const url = `https://export.arxiv.org/api/query?${new URLSearchParams({
    search_query: search,
    sortBy: 'relevance',
    max_results: String(max),
  })}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BilimManba/1.0 (https://bilimmanba.uz)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, e]) => ({
      title: tag(e, 'title'),
      url: (tag(e, 'id') || '').replace(/^http:/, 'https:'),
      summary: tag(e, 'summary'),
      published: tag(e, 'published').slice(0, 10),
      authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) =>
        decode(m[1]),
      ),
    }))
    .filter((p) => p.title && p.summary && p.url);
}
