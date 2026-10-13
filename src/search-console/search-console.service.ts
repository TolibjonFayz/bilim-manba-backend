import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/sequelize';
import { createSign } from 'crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

/**
 * Google Search Console (faqat o'qish): qidiruvdagi kliklar, ko'rinishlar,
 * so'rovlar, sahifalar, sitemap holati va maqolalarning indekslanganligi.
 *
 * Sozlash (bir martalik):
 *  - Google Cloud'da xizmat hisobi (service account) va JSON kalit;
 *  - Search Console API yoqiladi;
 *  - Search Console → Sozlamalar → Foydalanuvchilar: xizmat hisobi emaili qo'shiladi.
 * Env: GSC_CREDENTIALS — JSON kalit (oddiy yoki base64),
 *      GSC_SITE_URL — ixtiyoriy ("sc-domain:bilimmanba.uz" yoki "https://bilimmanba.uz/").
 */

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const WEBMASTERS = 'https://www.googleapis.com/webmasters/v3';
const INSPECT =
  'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const OVERVIEW_TTL_MS = 3 * 60 * 60 * 1000;
const INSPECT_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Row {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number, d = 1) => Math.round((n || 0) * 10 ** d) / 10 ** d;
const totalsOf = (rows: Row[] = []) => {
  const r = rows[0];
  return {
    clicks: r?.clicks ?? 0,
    impressions: r?.impressions ?? 0,
    ctr: round((r?.ctr ?? 0) * 100, 2),
    position: round(r?.position ?? 0),
  };
};

@Injectable()
export class SearchConsoleService {
  private readonly logger = new Logger(SearchConsoleService.name);
  private token?: { value: string; exp: number };
  private siteUrl?: string;
  private overviewCache = new Map<number, { at: number; data: any }>();

  constructor(
    private readonly config: ConfigService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  private get credentials(): {
    client_email: string;
    private_key: string;
  } | null {
    const raw = (this.config.get<string>('GSC_CREDENTIALS') ?? '').trim();
    if (!raw) return null;
    try {
      const json = raw.startsWith('{')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf8');
      const c = JSON.parse(json);
      return c?.client_email && c?.private_key ? c : null;
    } catch {
      return null;
    }
  }

  get configured() {
    return Boolean(this.credentials);
  }

  get serviceEmail() {
    return this.credentials?.client_email ?? null;
  }

  private get publicSite() {
    return (
      this.config.get<string>('SITE_URL') ?? 'https://bilimmanba.uz'
    ).replace(/\/+$/, '');
  }

  /** Xizmat hisobi bilan OAuth tokeni (JWT bearer, 1 soat) */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000)
      return this.token.value;
    const c = this.credentials;
    if (!c) throw new Error('GSC_CREDENTIALS sozlanmagan');
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: c.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(c.private_key.replace(/\\n/g, '\n'), 'base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      throw new Error(
        `Google token: ${j?.error_description ?? j?.error ?? res.status}`,
      );
    }
    this.token = {
      value: j.access_token,
      exp: Date.now() + (j.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  private async api(method: 'GET' | 'POST', url: string, body?: object) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `Search Console ${res.status}: ${j?.error?.message ?? ''}`,
      );
    }
    return j;
  }

  /** Xizmat hisobiga ochilgan sayt (env'da berilmagan bo'lsa — o'zi topadi) */
  private async site(): Promise<string> {
    if (this.siteUrl) return this.siteUrl;
    const fromEnv = this.config.get<string>('GSC_SITE_URL');
    if (fromEnv) return (this.siteUrl = fromEnv);
    const j = await this.api('GET', `${WEBMASTERS}/sites`);
    const sites: string[] = (j?.siteEntry ?? [])
      .filter((s: any) => s.permissionLevel !== 'siteUnverifiedUser')
      .map((s: any) => s.siteUrl);
    const host = new URL(this.publicSite).host.replace(/^www\./, '');
    const pick =
      sites.find((s) => s === `sc-domain:${host}`) ??
      sites.find((s) => s.includes(host)) ??
      sites[0];
    if (!pick) {
      throw new Error(
        `Xizmat hisobiga hech qaysi sayt ochilmagan — Search Console'da ${this.serviceEmail} ni foydalanuvchi qilib qo'shing`,
      );
    }
    return (this.siteUrl = pick);
  }

  private query(site: string, body: object): Promise<Row[]> {
    return this.api(
      'POST',
      `${WEBMASTERS}/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
      { dataState: 'all', ...body },
    ).then((j) => j?.rows ?? []);
  }

  /** Umumiy ko'rinish: so'nggi `days` kun ↔ undan oldingi `days` kun */
  async overview(days = 28) {
    if (!this.configured) {
      return { configured: false, serviceEmail: null };
    }
    days = [7, 28, 90].includes(days) ? days : 28;
    const cached = this.overviewCache.get(days);
    if (cached && Date.now() - cached.at < OVERVIEW_TTL_MS) return cached.data;

    const site = await this.site();
    // Search Console ma'lumoti 1–2 kun kechikadi
    const end = new Date(Date.now() - DAY_MS);
    const start = new Date(end.getTime() - (days - 1) * DAY_MS);
    const prevEnd = new Date(start.getTime() - DAY_MS);
    const prevStart = new Date(prevEnd.getTime() - (days - 1) * DAY_MS);
    const range = { startDate: ymd(start), endDate: ymd(end) };

    const [
      cur,
      prev,
      daily,
      queries,
      pages,
      countries,
      devices,
      many,
      sitemaps,
    ] = await Promise.all([
      this.query(site, range),
      this.query(site, { startDate: ymd(prevStart), endDate: ymd(prevEnd) }),
      this.query(site, { ...range, dimensions: ['date'], rowLimit: 500 }),
      this.query(site, { ...range, dimensions: ['query'], rowLimit: 25 }),
      this.query(site, { ...range, dimensions: ['page'], rowLimit: 25 }),
      this.query(site, { ...range, dimensions: ['country'], rowLimit: 6 }),
      this.query(site, { ...range, dimensions: ['device'], rowLimit: 5 }),
      this.query(site, { ...range, dimensions: ['query'], rowLimit: 500 }),
      this.api(
        'GET',
        `${WEBMASTERS}/sites/${encodeURIComponent(site)}/sitemaps`,
      )
        .then((j) => j?.sitemap ?? [])
        .catch(() => []),
    ]);

    const mapRows = (rows: Row[]) =>
      rows.map((r) => ({
        key: r.keys?.[0] ?? '',
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: round(r.ctr * 100, 2),
        position: round(r.position),
      }));

    // Imkoniyatlar: ko'p ko'rilgan, lekin 2-sahifada turgan yoki kam bosilgan so'rovlar
    const opportunities = mapRows(many)
      .map((r) => ({
        ...r,
        kind:
          r.position > 7 && r.position <= 20 && r.impressions >= 10
            ? 'page2'
            : r.position <= 7 && r.ctr < 3 && r.impressions >= 30
              ? 'lowCtr'
              : null,
      }))
      .filter((r) => r.kind)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 12);

    const data = {
      configured: true,
      site,
      serviceEmail: this.serviceEmail,
      range,
      previousRange: { startDate: ymd(prevStart), endDate: ymd(prevEnd) },
      totals: totalsOf(cur),
      previous: totalsOf(prev),
      daily: mapRows(daily).map(({ key, ...r }) => ({ date: key, ...r })),
      queries: mapRows(queries),
      pages: mapRows(pages).map((p) => ({
        ...p,
        path: p.key.replace(/^https?:\/\/[^/]+/, '') || '/',
      })),
      countries: mapRows(countries),
      devices: mapRows(devices),
      opportunities,
      sitemaps: sitemaps.map((s: any) => ({
        path: s.path,
        lastSubmitted: s.lastSubmitted ?? null,
        lastDownloaded: s.lastDownloaded ?? null,
        isPending: Boolean(s.isPending),
        errors: Number(s.errors ?? 0),
        warnings: Number(s.warnings ?? 0),
        submitted: Number(s.contents?.[0]?.submitted ?? 0),
      })),
      fetchedAt: new Date().toISOString(),
    };
    this.overviewCache.set(days, { at: Date.now(), data });
    return data;
  }

  // ---------- Indekslash holati ----------

  private async inspectCache(): Promise<Record<string, any>> {
    const rows = await this.sequelize.query<{ value: string }>(
      `SELECT value FROM app_settings WHERE key = 'gsc_inspect_cache'`,
      { type: QueryTypes.SELECT },
    );
    try {
      return JSON.parse(rows[0]?.value ?? '{}');
    } catch {
      return {};
    }
  }

  private async saveInspectCache(cache: Record<string, any>) {
    await this.sequelize.query(
      `INSERT INTO app_settings (key, value, "updatedAt") VALUES ('gsc_inspect_cache', :value, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      { replacements: { value: JSON.stringify(cache) } },
    );
  }

  /**
   * So'nggi chop etilgan maqolalar Google'da indekslanganmi (URL Inspection API,
   * kuniga 2000 so'rov limiti — natija 24 soat saqlanadi). refresh — keshni chetlab.
   */
  async indexing(limit = 20, refresh = false) {
    if (!this.configured) return { configured: false, items: [] };
    const site = await this.site();
    const articles = await this.sequelize.query<{
      id: number;
      title: string;
      slug: string;
      createdAt: string;
    }>(
      `SELECT id, title, slug, "createdAt" FROM articles
       WHERE status = 'published' ORDER BY "createdAt" DESC LIMIT :limit`,
      { replacements: { limit: Math.min(limit, 50) }, type: QueryTypes.SELECT },
    );
    const cache = await this.inspectCache();
    const items: any[] = [];
    for (const a of articles) {
      const url = `${this.publicSite}/articles/${a.slug}`;
      let hit = cache[url];
      // Havolasiz eski yozuvlar (birinchi versiya) ham qayta tekshiriladi
      if (
        refresh ||
        !hit ||
        !hit.link ||
        Date.now() - hit.at > INSPECT_TTL_MS
      ) {
        try {
          const j = await this.api('POST', INSPECT, {
            inspectionUrl: url,
            siteUrl: site,
            languageCode: 'en-US',
          });
          const r = j?.inspectionResult?.indexStatusResult ?? {};
          hit = {
            at: Date.now(),
            verdict: r.verdict ?? 'VERDICT_UNSPECIFIED',
            coverageState: r.coverageState ?? null,
            lastCrawlTime: r.lastCrawlTime ?? null,
            googleCanonical: r.googleCanonical ?? null,
            // Google o'zi beradigan havola — Search Console'da shu URL tekshiruvi
            // ochiladi ("Indekslashni so'rash" tugmasi o'sha yerda)
            link: j?.inspectionResult?.inspectionResultLink ?? null,
          };
          cache[url] = hit;
        } catch (err: any) {
          this.logger.warn(`URL tekshirilmadi (${url}): ${err?.message}`);
          hit = hit ?? {
            at: 0,
            verdict: 'ERROR',
            coverageState: String(err?.message ?? '').slice(0, 120),
          };
        }
      }
      items.push({
        id: a.id,
        title: a.title,
        url,
        publishedAt: a.createdAt,
        indexed: hit.verdict === 'PASS',
        verdict: hit.verdict,
        coverageState: hit.coverageState,
        lastCrawlTime: hit.lastCrawlTime,
        checkedAt: hit.at ? new Date(hit.at).toISOString() : null,
        // Google'ning havolasi bo'lmasa — Search Console bosh sahifasi
        // (tepadagi qidiruvga URL'ni qo'yib tekshirsa bo'ladi)
        inspectLink:
          hit.link ??
          `https://search.google.com/search-console?resource_id=${encodeURIComponent(site)}`,
      });
    }
    // Eski yozuvlar to'planib qolmasin — faqat ro'yxatdagilar saqlanadi
    const keep = Object.fromEntries(
      items.map((i) => [i.url, cache[i.url]]).filter(([, v]) => v),
    );
    await this.saveInspectCache(keep);
    return {
      configured: true,
      site,
      indexedCount: items.filter((i) => i.indexed).length,
      items,
    };
  }
}
