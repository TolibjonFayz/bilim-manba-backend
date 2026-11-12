import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { JwtService } from '@nestjs/jwt';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

/**
 * Saytning o'z statistikasi (Google Analytics'ga qaram emas): har bir
 * tashrifchi nima qilganini qadamma-qadam yozadi — qaysi sahifani ochdi,
 * maqolada necha soniya qoldi va qancha qismini o'qidi, qayerni bosdi,
 * emailni qaysi formaga kiritdi (ro'yxatdan o'tish yoki obuna), nima qidirdi.
 *
 * Shaxsni aniqlamaydi: brauzerdagi tasodifiy identifikator (visitorId),
 * IP saqlanmaydi; mamlakat Cloudflare sarlavhasidan. Kirgan foydalanuvchi
 * bo'lsa — userId (token tekshiriladi).
 */

export type Period = 'day' | 'week' | 'month' | 'year';

const DAY_MS = 24 * 60 * 60 * 1000;
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const RETENTION_DAYS = 400;

const PERIODS: Record<
  Period,
  { days: number; unit: 'day' | 'week' | 'month'; points: number }
> = {
  day: { days: 1, unit: 'day', points: 14 },
  week: { days: 7, unit: 'day', points: 14 },
  month: { days: 30, unit: 'day', points: 30 },
  year: { days: 365, unit: 'month', points: 12 },
};

/** Brauzerdan keladigan hodisa turlari — boshqasi qabul qilinmaydi */
export const EVENT_TYPES = new Set([
  'page_view',
  'page_exit',
  'link_click',
  'search',
  'email_focus',
  'email_submit',
  'like',
  'bookmark',
  'share',
  'comment',
  'quiz_done',
  'ai_question',
  'install_app',
  'theme_toggle',
]);

const ID_RE = /^[a-zA-Z0-9_-]{8,40}$/;
const BOT_RE =
  /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp|vkshare|python|curl|wget|httpclient|monitor|uptime/i;

const local = (col: string) =>
  `((${col} AT TIME ZONE 'UTC') + interval '5 hours')`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Toshkent sanasining boshlanishi (UTC vaqt) */
const dayStart = (day: string) => new Date(`${day}T00:00:00+05:00`);

export interface IngestBody {
  v?: unknown; // visitorId
  s?: unknown; // sessionId
  tk?: unknown; // JWT (kirgan bo'lsa)
  now?: unknown; // brauzer soati (ms) — vaqt farqini tuzatish uchun
  internal?: unknown; // admin brauzeri — yozilmaydi
  ctx?: any; // sessiya boshida: referrer, utm, landing, ekran
  e?: unknown;
}

const str = (v: unknown, max: number) =>
  typeof v === 'string' && v ? v.slice(0, max) : null;

/** Tashrif manbasi: utm yoki referrer'dan */
export function classifySource(
  referrer: string | null,
  utmSource: string | null,
): string {
  const u = (utmSource ?? '').toLowerCase();
  if (u) {
    if (/telegram|^tg$/.test(u)) return 'Telegram';
    if (/instagram|^ig$/.test(u)) return 'Instagram';
    if (/facebook|^fb$/.test(u)) return 'Facebook';
    if (/google/.test(u)) return 'Google';
    if (/yandex/.test(u)) return 'Yandex';
    if (/youtube/.test(u)) return 'YouTube';
    if (/email|newsletter|mail/.test(u)) return 'Email';
    return u.slice(0, 30);
  }
  if (!referrer) return "To'g'ridan-to'g'ri";
  let host = '';
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    if (/org\.telegram/.test(referrer)) return 'Telegram';
    return 'Boshqa';
  }
  if (!host || /(^|\.)bilimmanba\.uz$/.test(host)) return "To'g'ridan-to'g'ri";
  if (/(^|\.)google\./.test(host)) return 'Google';
  if (/(^|\.)(yandex\.|ya\.ru$)/.test(host)) return 'Yandex';
  if (/(^|\.)bing\.com$|duckduckgo/.test(host)) return 'Boshqa qidiruv';
  if (/(^|\.)(t\.me|telegram\.(org|me))$/.test(host) || /org\.telegram/.test(referrer))
    return 'Telegram';
  if (/instagram\.com$/.test(host)) return 'Instagram';
  if (/facebook\.com$|fb\.com$/.test(host)) return 'Facebook';
  if (/youtube\.com$|youtu\.be$/.test(host)) return 'YouTube';
  if (/(^|\.)(vk\.com|ok\.ru)$/.test(host)) return 'VK/OK';
  return host.replace(/^www\./, '').slice(0, 40);
}

export function parseUa(ua: string) {
  const device = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)
    ? 'Planshet'
    : /Mobi|iPhone|iPod|Android/i.test(ua)
      ? 'Telefon'
      : 'Kompyuter';
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/i.test(ua)
          ? 'macOS'
          : /CrOS/i.test(ua)
            ? 'ChromeOS'
            : /Linux/i.test(ua)
              ? 'Linux'
              : 'Boshqa';
  const browser = /Telegram/i.test(ua)
    ? 'Telegram ichida'
    : /Instagram/i.test(ua)
      ? 'Instagram ichida'
      : /FBAN|FBAV/i.test(ua)
        ? 'Facebook ichida'
        : /YaBrowser/i.test(ua)
          ? 'Yandex Browser'
          : /Edg\//i.test(ua)
            ? 'Edge'
            : /OPR\/|Opera/i.test(ua)
              ? 'Opera'
              : /SamsungBrowser/i.test(ua)
                ? 'Samsung Internet'
                : /Firefox|FxiOS/i.test(ua)
                  ? 'Firefox'
                  : /Chrome|CriOS/i.test(ua)
                    ? 'Chrome'
                    : /Safari/i.test(ua)
                      ? 'Safari'
                      : 'Boshqa';
  return { device, os, browser };
}

@Injectable()
export class AnalyticsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsService.name);
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly jwt: JwtService,
  ) {}

  onModuleInit() {
    // Eski yozuvlar (400 kundan oshgan) kuniga bir marta tozalanadi
    this.cleanupTimer = setInterval(() => void this.cleanup(), DAY_MS);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async cleanup() {
    try {
      await this.sequelize.query(
        `DELETE FROM analytics_events WHERE "createdAt" < now() - interval '${RETENTION_DAYS} days'`,
      );
      await this.sequelize.query(
        `DELETE FROM analytics_sessions WHERE "lastAt" < now() - interval '${RETENTION_DAYS} days'`,
      );
    } catch (err: any) {
      this.logger.warn(`Statistika tozalanmadi: ${err?.message}`);
    }
  }

  private rows<T extends object = any>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) {
    return this.sequelize.query<T>(sql, {
      replacements,
      type: QueryTypes.SELECT,
    });
  }

  private async one<T extends object = any>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ): Promise<T> {
    return (await this.rows<T>(sql, replacements))[0];
  }

  private userFromToken(token: unknown): { id: number; admin: boolean } | null {
    if (typeof token !== 'string' || token.length > 2000) return null;
    try {
      const p: any = this.jwt.verify(token);
      const id = Number(p?.sub ?? p?.userId ?? p?.id);
      return Number.isInteger(id) && id > 0
        ? { id, admin: p?.role === 'admin' }
        : null;
    } catch {
      return null;
    }
  }

  // ---------- Qabul qilish ----------

  /**
   * Brauzerdan bir to'plam hodisa. Xato ma'lumotni jim tashlab yuboradi
   * (statistika sayt ishiga xalaqit bermasin).
   */
  async ingest(
    body: IngestBody,
    meta: { ua: string; country?: string | null },
  ): Promise<{ ok: boolean; stored: number }> {
    if (!body || typeof body !== 'object') return { ok: false, stored: 0 };
    const visitorId = typeof body.v === 'string' && ID_RE.test(body.v) ? body.v : null;
    const sessionId = typeof body.s === 'string' && ID_RE.test(body.s) ? body.s : null;
    if (!visitorId || !sessionId) return { ok: false, stored: 0 };
    if (body.internal === true) return { ok: true, stored: 0 };
    if (!meta.ua || BOT_RE.test(meta.ua)) return { ok: true, stored: 0 };

    const user = this.userFromToken(body.tk);
    // Admin o'z saytini ko'rganda statistika buzilmasin
    if (user?.admin) return { ok: true, stored: 0 };

    const serverNow = Date.now();
    const clientNow = Number(body.now);
    const skew =
      Number.isFinite(clientNow) && Math.abs(serverNow - clientNow) < 7 * DAY_MS
        ? serverNow - clientNow
        : 0;

    const raw = Array.isArray(body.e) ? body.e.slice(0, 60) : [];
    const events: {
      type: string;
      path: string | null;
      at: Date;
      data: string | null;
    }[] = [];
    let pageviews = 0;
    let addSeconds = 0;
    for (const ev of raw as any[]) {
      const type = str(ev?.t, 40);
      if (!type || !EVENT_TYPES.has(type)) continue;
      let at = Number(ev?.ts) + skew;
      if (!Number.isFinite(at) || Math.abs(serverNow - at) > DAY_MS) at = serverNow;
      let data: string | null = null;
      if (ev?.d && typeof ev.d === 'object') {
        const s = JSON.stringify(ev.d);
        if (s.length <= 2000) data = s;
      }
      if (type === 'page_view') pageviews++;
      if (type === 'page_exit') {
        const add = Math.round(Number(ev?.d?.add));
        if (Number.isFinite(add) && add > 0) addSeconds += Math.min(add, 1800);
      }
      events.push({ type, path: str(ev?.p, 300), at: new Date(at), data });
    }
    if (!events.length) return { ok: true, stored: 0 };

    const ctx = body.ctx && typeof body.ctx === 'object' ? body.ctx : {};
    const referrer = str(ctx.ref, 500);
    const utmSource = str(ctx.us, 60);
    const { device, os, browser } = parseUa(meta.ua);
    const first = events.reduce((a, b) => (a.at < b.at ? a : b));
    const last = events.reduce((a, b) => (a.at > b.at ? a : b));

    await this.sequelize.query(
      `INSERT INTO analytics_sessions
         (id, "visitorId", "userId", "startedAt", "lastAt", "landingPath", referrer,
          "source", "utmSource", "utmMedium", "utmCampaign", device, os, browser,
          country, "screen", pageviews, events, "activeSeconds", "isNew")
       VALUES (:sessionId, :visitorId, :userId, :firstAt, :lastAt, :landing, :referrer,
          :source, :utmSource, :utmMedium, :utmCampaign, :device, :os, :browser,
          :country, :screen, :pageviews, :n, :addSeconds,
          NOT EXISTS (SELECT 1 FROM analytics_sessions o WHERE o."visitorId" = :visitorId))
       ON CONFLICT (id) DO UPDATE SET
         "lastAt" = GREATEST(analytics_sessions."lastAt", EXCLUDED."lastAt"),
         "userId" = COALESCE(EXCLUDED."userId", analytics_sessions."userId"),
         pageviews = analytics_sessions.pageviews + EXCLUDED.pageviews,
         events = analytics_sessions.events + EXCLUDED.events,
         "activeSeconds" = analytics_sessions."activeSeconds" + EXCLUDED."activeSeconds"`,
      {
        replacements: {
          sessionId,
          visitorId,
          userId: user?.id ?? null,
          firstAt: first.at,
          lastAt: last.at,
          landing: str(ctx.landing, 300) ?? first.path,
          referrer,
          source: classifySource(referrer, utmSource),
          utmSource,
          utmMedium: str(ctx.um, 60),
          utmCampaign: str(ctx.uc, 100),
          device,
          os,
          browser,
          country: str(meta.country, 4),
          screen: str(ctx.sc, 20),
          pageviews,
          n: events.length,
          addSeconds,
        },
      },
    );

    const values: string[] = [];
    const rep: Record<string, unknown> = {
      visitorId,
      sessionId,
      userId: user?.id ?? null,
    };
    events.forEach((ev, i) => {
      values.push(
        `(:visitorId, :sessionId, :userId, :t${i}, :p${i}, CAST(:d${i} AS jsonb), :a${i})`,
      );
      rep[`t${i}`] = ev.type;
      rep[`p${i}`] = ev.path;
      rep[`d${i}`] = ev.data;
      rep[`a${i}`] = ev.at;
    });
    await this.sequelize.query(
      `INSERT INTO analytics_events ("visitorId", "sessionId", "userId", type, path, data, "createdAt")
       VALUES ${values.join(', ')}`,
      { replacements: rep },
    );
    return { ok: true, stored: events.length };
  }

  /** Ro'yxatdan o'tish / obuna — email qaysi formada kiritilganini saqlash */
  async markSignup(
    table: 'users' | 'subscribers',
    id: number | string,
    source: unknown,
    path: unknown,
  ) {
    const s = str(source, 60);
    const p = str(path, 300);
    if (!s && !p) return;
    const where = table === 'users' ? 'id = :id' : 'email = :id';
    await this.sequelize
      .query(
        `UPDATE ${table} SET "signupSource" = COALESCE(:s, "signupSource"), "signupPath" = COALESCE(:p, "signupPath") WHERE ${where}`,
        { replacements: { s, p, id } },
      )
      .catch((err) =>
        this.logger.warn(`Email manbasi saqlanmadi: ${err?.message}`),
      );
  }

  // ---------- Hisobot ----------

  private ranges(period: Period, now = new Date()) {
    const cfg = PERIODS[period];
    if (!cfg) throw new BadRequestException("Davr noto'g'ri");
    const today = new Date(now.getTime() + TASHKENT_OFFSET_MS);
    today.setUTCHours(0, 0, 0, 0);
    const curFrom = new Date(today.getTime() - (cfg.days - 1) * DAY_MS);
    const prevTo = new Date(curFrom.getTime() - DAY_MS);
    const prevFrom = new Date(prevTo.getTime() - (cfg.days - 1) * DAY_MS);
    const seriesFrom =
      cfg.unit === 'day'
        ? new Date(today.getTime() - (cfg.points - 1) * DAY_MS)
        : new Date(
            Date.UTC(
              today.getUTCFullYear(),
              today.getUTCMonth() - (cfg.points - 1),
              1,
            ),
          );
    const win = (from: Date, to: Date) => ({
      from: ymd(from),
      to: ymd(to),
      f: dayStart(ymd(from)),
      t: new Date(dayStart(ymd(to)).getTime() + DAY_MS),
    });
    return {
      cfg,
      cur: win(curFrom, today),
      prev: win(prevFrom, prevTo),
      series: win(seriesFrom, today),
    };
  }

  private async overview(f: Date, t: Date) {
    const s = await this.one<Record<string, string>>(
      `SELECT COUNT(*) AS sessions,
         COUNT(DISTINCT "visitorId") AS visitors,
         COUNT(DISTINCT "visitorId") FILTER (WHERE "isNew") AS "newVisitors",
         COUNT(DISTINCT "userId") AS "loggedIn",
         COALESCE(SUM(pageviews), 0) AS pageviews,
         COALESCE(SUM("activeSeconds"), 0) AS "totalSeconds",
         COUNT(*) FILTER (WHERE pageviews <= 1 AND "activeSeconds" < 15) AS bounces
       FROM analytics_sessions WHERE "startedAt" >= :f AND "startedAt" < :t`,
      { f, t },
    );
    const e = await this.one<Record<string, string>>(
      `SELECT
         COUNT(*) FILTER (WHERE type = 'email_submit' AND data->>'ok' = 'true' AND data->>'form' = 'register') AS signups,
         COUNT(*) FILTER (WHERE type = 'email_submit' AND data->>'ok' = 'true' AND data->>'form' LIKE 'newsletter%') AS subscribes,
         COUNT(*) FILTER (WHERE type = 'page_view' AND path LIKE '/articles/%') AS "articleViews",
         COUNT(*) FILTER (WHERE type IN ('like','bookmark','share','comment','quiz_done','ai_question')) AS actions
       FROM analytics_events WHERE "createdAt" >= :f AND "createdAt" < :t`,
      { f, t },
    );
    const n = (v: unknown) => Number(v) || 0;
    const sessions = n(s.sessions);
    return {
      visitors: n(s.visitors),
      newVisitors: n(s.newVisitors),
      returningVisitors: Math.max(0, n(s.visitors) - n(s.newVisitors)),
      loggedIn: n(s.loggedIn),
      sessions,
      pageviews: n(s.pageviews),
      articleViews: n(e.articleViews),
      totalMinutes: Math.round(n(s.totalSeconds) / 60),
      avgSessionSeconds: sessions ? Math.round(n(s.totalSeconds) / sessions) : 0,
      pagesPerSession: sessions
        ? Math.round((n(s.pageviews) / sessions) * 10) / 10
        : 0,
      bounceRate: sessions ? Math.round((n(s.bounces) / sessions) * 100) : 0,
      signups: n(e.signups),
      subscribes: n(e.subscribes),
      actions: n(e.actions),
    };
  }

  private async series(unit: string, from: string, to: string) {
    const rows = await this.rows<Record<string, string>>(
      `WITH b AS (
         SELECT generate_series(
           date_trunc(:unit, CAST(:from AS date)),
           date_trunc(:unit, CAST(:to AS date)),
           CAST('1 ' || :unit AS interval)
         )::date AS b
       ),
       s AS (
         SELECT date_trunc(:unit, ${local('"startedAt"')})::date AS b,
           COUNT(*) AS sessions, COUNT(DISTINCT "visitorId") AS visitors,
           SUM(pageviews) AS pageviews, SUM("activeSeconds") AS seconds
         FROM analytics_sessions
         WHERE "startedAt" >= :f
         GROUP BY 1
       )
       SELECT to_char(b.b, 'YYYY-MM-DD') AS bucket,
         COALESCE(s.visitors, 0) AS visitors, COALESCE(s.sessions, 0) AS sessions,
         COALESCE(s.pageviews, 0) AS pageviews, COALESCE(s.seconds, 0) AS seconds
       FROM b LEFT JOIN s ON s.b = b.b ORDER BY b.b`,
      { unit, from, to, f: dayStart(from) },
    );
    return rows.map((r) => ({
      bucket: r.bucket,
      visitors: Number(r.visitors) || 0,
      sessions: Number(r.sessions) || 0,
      pageviews: Number(r.pageviews) || 0,
      minutes: Math.round((Number(r.seconds) || 0) / 60),
    }));
  }

  private async groupSessions(col: string, f: Date, t: Date, limit = 10) {
    const rows = await this.rows<Record<string, string>>(
      `SELECT COALESCE(${col}, 'Nomaʼlum') AS name, COUNT(*) AS sessions,
         COUNT(DISTINCT "visitorId") AS visitors,
         ROUND(AVG("activeSeconds")) AS "avgSeconds",
         ROUND(AVG(pageviews)::numeric, 1) AS "pagesPerSession"
       FROM analytics_sessions WHERE "startedAt" >= :f AND "startedAt" < :t
       GROUP BY 1 ORDER BY sessions DESC LIMIT ${limit}`,
      { f, t },
    );
    return rows.map((r) => ({
      name: r.name,
      sessions: Number(r.sessions) || 0,
      visitors: Number(r.visitors) || 0,
      avgSeconds: Number(r.avgSeconds) || 0,
      pagesPerSession: Number(r.pagesPerSession) || 0,
    }));
  }

  private async heatmap(f: Date, t: Date) {
    const rows = await this.rows<Record<string, string>>(
      `SELECT EXTRACT(ISODOW FROM ${local('"startedAt"')})::int AS dow,
         EXTRACT(HOUR FROM ${local('"startedAt"')})::int AS hour, COUNT(*) AS n
       FROM analytics_sessions WHERE "startedAt" >= :f AND "startedAt" < :t
       GROUP BY 1, 2`,
      { f, t },
    );
    return rows.map((r) => ({
      dow: Number(r.dow),
      hour: Number(r.hour),
      n: Number(r.n),
    }));
  }

  /** Har bir sahifa ko'rishining yakuniy holati: necha soniya, qancha qismi o'qildi */
  private exitsCte() {
    return `exits AS (
      SELECT DISTINCT ON (data->>'pv') path, "visitorId", "sessionId",
        LEAST(COALESCE((data->>'sec')::int, 0), 3600) AS sec,
        LEAST(COALESCE((data->>'scroll')::int, 0), 100) AS scroll
      FROM analytics_events
      WHERE type = 'page_exit' AND "createdAt" >= :f AND "createdAt" < CAST(:t AS timestamptz) + interval '1 day'
        AND data->>'pv' IS NOT NULL
      ORDER BY data->>'pv', (data->>'sec')::int DESC
    )`;
  }

  private async articles(f: Date, t: Date) {
    const rows = await this.rows<Record<string, string>>(
      `WITH pv AS (
         SELECT path, COUNT(*) AS views, COUNT(DISTINCT "visitorId") AS readers
         FROM analytics_events
         WHERE type = 'page_view' AND path LIKE '/articles/%' AND "createdAt" >= :f AND "createdAt" < :t
         GROUP BY path
       ),
       ${this.exitsCte()},
       ex AS (
         SELECT path, ROUND(AVG(sec)) AS "avgSec", COUNT(*) AS exits,
           COUNT(*) FILTER (WHERE scroll >= 90 AND sec >= 20) AS finished,
           ROUND(AVG(scroll)) AS "avgScroll"
         FROM exits WHERE path LIKE '/articles/%' GROUP BY path
       ),
       land AS (
         SELECT "landingPath" AS path, COUNT(*) AS entries
         FROM analytics_sessions WHERE "startedAt" >= :f AND "startedAt" < :t
         GROUP BY 1
       )
       SELECT pv.path, pv.views, pv.readers, ex."avgSec", ex.exits, ex.finished,
         ex."avgScroll", COALESCE(land.entries, 0) AS entries,
         a.id, a.title, c.name AS category
       FROM pv
       LEFT JOIN ex ON ex.path = pv.path
       LEFT JOIN land ON land.path = pv.path
       LEFT JOIN articles a ON '/articles/' || a.slug = pv.path
       LEFT JOIN categories c ON c.id = a."categoryId"
       ORDER BY pv.views DESC LIMIT 25`,
      { f, t },
    );
    return rows.map((r) => {
      const exits = Number(r.exits) || 0;
      return {
        id: r.id ? Number(r.id) : null,
        title: r.title ?? decodeURIComponent(r.path.replace('/articles/', '')),
        path: r.path,
        category: r.category ?? null,
        views: Number(r.views) || 0,
        readers: Number(r.readers) || 0,
        avgSeconds: Number(r.avgSec) || 0,
        avgScroll: Number(r.avgScroll) || 0,
        finishRate: exits ? Math.round(((Number(r.finished) || 0) / exits) * 100) : 0,
        entries: Number(r.entries) || 0,
      };
    });
  }

  private async pages(f: Date, t: Date) {
    const rows = await this.rows<Record<string, string>>(
      `WITH ${this.exitsCte()}
       SELECT CASE
           WHEN path = '/' THEN 'Bosh sahifa'
           WHEN path LIKE '/articles/%' THEN 'Maqolalar (bitta maqola)'
           WHEN path = '/articles' THEN 'Maqolalar ro''yxati'
           WHEN path LIKE '/categories%' THEN 'Kategoriyalar'
           WHEN path LIKE '/series%' THEN 'Seriyalar'
           WHEN path LIKE '/maktab%' THEN 'Maktab'
           WHEN path IN ('/register', '/login', '/forgot-password') THEN 'Kirish / ro''yxatdan o''tish'
           WHEN path = '/reyting' THEN 'Reyting'
           WHEN path = '/profile' THEN 'Profil'
           ELSE 'Boshqa sahifalar' END AS name,
         COUNT(*) AS views, ROUND(AVG(sec)) AS "avgSec"
       FROM exits GROUP BY 1 ORDER BY views DESC`,
      { f, t },
    );
    return rows.map((r) => ({
      name: r.name,
      views: Number(r.views) || 0,
      avgSeconds: Number(r.avgSec) || 0,
    }));
  }

  private async clicks(f: Date, t: Date) {
    const areas = await this.rows<Record<string, string>>(
      `SELECT COALESCE(data->>'area', 'boshqa') AS area, COUNT(*) AS n,
         COUNT(*) FILTER (WHERE data->>'to' LIKE '/articles/%') AS "toArticles"
       FROM analytics_events
       WHERE type = 'link_click' AND "createdAt" >= :f AND "createdAt" < :t
       GROUP BY 1 ORDER BY n DESC LIMIT 15`,
      { f, t },
    );
    const outbound = await this.rows<Record<string, string>>(
      `SELECT data->>'to' AS url, COUNT(*) AS n
       FROM analytics_events
       WHERE type = 'link_click' AND data->>'ext' = 'true' AND "createdAt" >= :f AND "createdAt" < :t
       GROUP BY 1 ORDER BY n DESC LIMIT 8`,
      { f, t },
    );
    return {
      areas: areas.map((r) => ({
        area: r.area,
        clicks: Number(r.n) || 0,
        toArticles: Number(r.toArticles) || 0,
      })),
      outbound: outbound.map((r) => ({ url: r.url, clicks: Number(r.n) || 0 })),
    };
  }

  private async forms(f: Date, t: Date) {
    const rows = await this.rows<Record<string, string>>(
      `SELECT data->>'form' AS form,
         COUNT(DISTINCT "sessionId") FILTER (WHERE type = 'email_focus') AS started,
         COUNT(*) FILTER (WHERE type = 'email_submit') AS submitted,
         COUNT(*) FILTER (WHERE type = 'email_submit' AND data->>'ok' = 'true') AS ok
       FROM analytics_events
       WHERE type IN ('email_focus', 'email_submit') AND "createdAt" >= :f AND "createdAt" < :t
         AND data->>'form' IS NOT NULL
       GROUP BY 1 ORDER BY started DESC`,
      { f, t },
    );
    const errors = await this.rows<Record<string, string>>(
      `SELECT data->>'form' AS form, LEFT(COALESCE(data->>'err', 'xato'), 120) AS err, COUNT(*) AS n
       FROM analytics_events
       WHERE type = 'email_submit' AND data->>'ok' = 'false' AND "createdAt" >= :f AND "createdAt" < :t
       GROUP BY 1, 2 ORDER BY n DESC LIMIT 10`,
      { f, t },
    );
    // Haqiqiy emaillar (bazada allaqachon bor) — qaysi formadan, qaysi sahifada
    const recent = await this.rows<Record<string, any>>(
      `SELECT x.*, t."pathTitle" FROM (
         SELECT email, 'register' AS kind, "signupSource" AS form, "signupPath" AS path,
           "fullName" AS name, "createdAt"
         FROM users WHERE "createdAt" >= :f AND "createdAt" < :t
         UNION ALL
         SELECT email, 'newsletter' AS kind, "signupSource" AS form, "signupPath" AS path,
           NULL AS name, "createdAt"
         FROM subscribers WHERE "createdAt" >= :f AND "createdAt" < :t
       ) x
       LEFT JOIN LATERAL (
         SELECT a.title AS "pathTitle" FROM articles a
         WHERE x.path LIKE '/articles/%' AND '/articles/' || a.slug = split_part(x.path, '?', 1)
         LIMIT 1
       ) t ON true
       ORDER BY x."createdAt" DESC LIMIT 40`,
      { f, t },
    );
    return {
      forms: rows.map((r) => ({
        form: r.form,
        started: Number(r.started) || 0,
        submitted: Number(r.submitted) || 0,
        ok: Number(r.ok) || 0,
      })),
      errors: errors.map((r) => ({ form: r.form, error: r.err, count: Number(r.n) || 0 })),
      recent: recent.map((r) => ({
        email: r.email,
        kind: r.kind,
        form: r.form ?? null,
        path: r.path ?? null,
        pathTitle: r.pathTitle ?? null,
        name: r.name ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  private async funnel(f: Date, t: Date) {
    const r = await this.one<Record<string, string>>(
      `WITH ${this.exitsCte()},
       v AS (SELECT DISTINCT "visitorId" FROM analytics_sessions WHERE "startedAt" >= :f AND "startedAt" < :t),
       ev AS (SELECT * FROM analytics_events WHERE "createdAt" >= :f AND "createdAt" < :t)
       SELECT
         (SELECT COUNT(*) FROM v) AS visitors,
         (SELECT COUNT(DISTINCT "visitorId") FROM ev WHERE type = 'page_view' AND path LIKE '/articles/%') AS opened,
         (SELECT COUNT(DISTINCT "visitorId") FROM exits WHERE path LIKE '/articles/%' AND sec >= 30) AS read30,
         (SELECT COUNT(DISTINCT "visitorId") FROM exits WHERE path LIKE '/articles/%' AND scroll >= 90 AND sec >= 20) AS finished,
         (SELECT COUNT(DISTINCT "visitorId") FROM ev WHERE type IN ('like','bookmark','share','comment','quiz_done','ai_question')) AS engaged,
         (SELECT COUNT(DISTINCT "visitorId") FROM ev WHERE type = 'email_focus') AS "emailStarted",
         (SELECT COUNT(DISTINCT "visitorId") FROM ev WHERE type = 'email_submit' AND data->>'ok' = 'true') AS converted`,
      { f, t },
    );
    return Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, Number(v) || 0]),
    );
  }

  private async actions(f: Date, t: Date) {
    const rows = await this.rows<Record<string, string>>(
      `SELECT type, COUNT(*) AS n FROM analytics_events
       WHERE type IN ('like','bookmark','share','comment','quiz_done','ai_question','install_app','theme_toggle','search')
         AND "createdAt" >= :f AND "createdAt" < :t
       GROUP BY type`,
      { f, t },
    );
    return Object.fromEntries(rows.map((r) => [r.type, Number(r.n) || 0]));
  }

  private async searches(f: Date, t: Date) {
    const rows = await this.rows<Record<string, string>>(
      `SELECT LOWER(TRIM(data->>'q')) AS q, COUNT(*) AS n,
         MIN(COALESCE((data->>'results')::int, 0)) AS "minResults"
       FROM analytics_events
       WHERE type = 'search' AND "createdAt" >= :f AND "createdAt" < :t AND COALESCE(data->>'q', '') <> ''
       GROUP BY 1 ORDER BY n DESC LIMIT 15`,
      { f, t },
    );
    return rows.map((r) => ({
      query: r.q,
      count: Number(r.n) || 0,
      noResults: (Number(r.minResults) || 0) === 0,
    }));
  }

  async live() {
    const rows = await this.rows<Record<string, any>>(
      `SELECT s.id, s.device, s."source", s.country,
         (SELECT e.path FROM analytics_events e WHERE e."sessionId" = s.id ORDER BY e."createdAt" DESC LIMIT 1) AS path
       FROM analytics_sessions s
       WHERE s."lastAt" > now() - interval '5 minutes'
       ORDER BY s."lastAt" DESC LIMIT 30`,
    );
    return { count: rows.length, sessions: rows };
  }

  private async recentSessions(f: Date, t: Date) {
    const rows = await this.rows<Record<string, any>>(
      `SELECT s.id, s."visitorId", s."startedAt", s."lastAt", s."landingPath", s."source",
         s.device, s.os, s.browser, s.country, s.pageviews, s.events, s."activeSeconds", s."isNew",
         u."fullName" AS "userName", u.email AS "userEmail",
         (SELECT COUNT(*) FROM analytics_sessions o WHERE o."visitorId" = s."visitorId") AS visits
       FROM analytics_sessions s
       LEFT JOIN users u ON u.id = s."userId"
       WHERE s."startedAt" >= :f AND s."startedAt" < :t
       ORDER BY s."startedAt" DESC LIMIT 50`,
      { f, t },
    );
    return rows.map((r) => ({
      ...r,
      pageviews: Number(r.pageviews) || 0,
      events: Number(r.events) || 0,
      activeSeconds: Number(r.activeSeconds) || 0,
      visits: Number(r.visits) || 0,
    }));
  }

  /** Bitta tashrif: qadamma-qadam hamma hodisalar */
  async session(id: string) {
    if (!ID_RE.test(id)) throw new BadRequestException("Noto'g'ri tashrif");
    const session = await this.one<Record<string, any>>(
      `SELECT s.*, u."fullName" AS "userName", u.email AS "userEmail"
       FROM analytics_sessions s LEFT JOIN users u ON u.id = s."userId" WHERE s.id = :id`,
      { id },
    );
    if (!session) return null;
    const events = await this.rows<Record<string, any>>(
      `SELECT e.type, e.path, e.data, e."createdAt", a.title AS "articleTitle"
       FROM analytics_events e
       LEFT JOIN articles a ON e.path LIKE '/articles/%' AND '/articles/' || a.slug = e.path
       WHERE e."sessionId" = :id ORDER BY e."createdAt", e.id LIMIT 500`,
      { id },
    );
    const visits = await this.rows<Record<string, any>>(
      `SELECT id, "startedAt", pageviews, "activeSeconds", "source"
       FROM analytics_sessions WHERE "visitorId" = :v ORDER BY "startedAt" DESC LIMIT 20`,
      { v: session.visitorId },
    );
    return { session, events, visits };
  }

  async report(period: Period, now = new Date()) {
    const { cfg, cur, prev, series } = this.ranges(period, now);
    const [
      current,
      previous,
      points,
      sources,
      devices,
      os,
      browsers,
      countries,
      heat,
      articles,
      pages,
      clicks,
      forms,
      funnel,
      actions,
      searches,
      live,
      sessions,
      since,
    ] = await Promise.all([
      this.overview(cur.f, cur.t),
      this.overview(prev.f, prev.t),
      this.series(cfg.unit, series.from, series.to),
      this.groupSessions('"source"', cur.f, cur.t, 12),
      this.groupSessions('device', cur.f, cur.t, 5),
      this.groupSessions('os', cur.f, cur.t, 8),
      this.groupSessions('browser', cur.f, cur.t, 10),
      this.groupSessions('country', cur.f, cur.t, 10),
      this.heatmap(cur.f, cur.t),
      this.articles(cur.f, cur.t),
      this.pages(cur.f, cur.t),
      this.clicks(cur.f, cur.t),
      this.forms(cur.f, cur.t),
      this.funnel(cur.f, cur.t),
      this.actions(cur.f, cur.t),
      this.searches(cur.f, cur.t),
      this.live(),
      this.recentSessions(cur.f, cur.t),
      this.one<{ since: string | null }>(
        `SELECT to_char(MIN(${local('"startedAt"')}), 'YYYY-MM-DD') AS since FROM analytics_sessions`,
      ),
    ]);
    return {
      period,
      range: { from: cur.from, to: cur.to },
      previousRange: { from: prev.from, to: prev.to },
      trackedSince: since?.since ?? null,
      current,
      previous,
      series: { unit: cfg.unit, points },
      sources,
      devices,
      os,
      browsers,
      countries,
      heatmap: heat,
      articles,
      pages,
      clicks,
      forms,
      funnel,
      actions,
      searches,
      live,
      sessions,
    };
  }
}
