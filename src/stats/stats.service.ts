import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

export type Period = 'day' | 'week' | 'month' | 'year';

const DAY_MS = 24 * 60 * 60 * 1000;
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

// timestamptz → Toshkent mahalliy vaqti (O'zbekistonda yozgi vaqt yo'q, doim +5)
const local = (col: string) =>
  `((${col} AT TIME ZONE 'UTC') + interval '5 hours')`;

/**
 * Hisobot oynalari (Toshkent sanasi bilan):
 *  - day:   bugun ↔ kecha; grafik — so'nggi 14 kun
 *  - week:  so'nggi 7 kun ↔ undan oldingi 7 kun; grafik — 12 hafta
 *  - month: so'nggi 30 kun ↔ undan oldingi 30 kun; grafik — 30 kun
 *  - year:  so'nggi 365 kun ↔ undan oldingi 365 kun; grafik — 12 oy
 */
const PERIODS: Record<
  Period,
  { days: number; unit: 'day' | 'week' | 'month'; points: number }
> = {
  day: { days: 1, unit: 'day', points: 14 },
  week: { days: 7, unit: 'week', points: 12 },
  month: { days: 30, unit: 'day', points: 30 },
  year: { days: 365, unit: 'month', points: 12 },
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface Metrics {
  views: number;
  newUsers: number;
  likes: number;
  comments: number;
  subscribers: number;
  published: number;
  activeReaders: number;
}

@Injectable()
export class StatsService {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private async one<T extends object = any>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ): Promise<T> {
    const rows = await this.sequelize.query<T>(sql, {
      replacements,
      type: QueryTypes.SELECT,
    });
    return rows[0];
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

  private async metrics(from: string, to: string): Promise<Metrics> {
    const r = { from, to };
    const inRange = (col: string) =>
      `${local(col)}::date BETWEEN :from AND :to`;
    const row = await this.one<Record<string, string>>(
      `SELECT
        (SELECT COALESCE(SUM(views), 0) FROM daily_views WHERE day BETWEEN :from AND :to) AS views,
        (SELECT COUNT(*) FROM users WHERE ${inRange('"createdAt"')}) AS "newUsers",
        (SELECT COUNT(*) FROM likes WHERE ${inRange('"createdAt"')}) AS likes,
        (SELECT COUNT(*) FROM comments WHERE ${inRange('"createdAt"')}) AS comments,
        (SELECT COUNT(*) FROM subscribers WHERE ${inRange('"createdAt"')}) AS subscribers,
        (SELECT COUNT(*) FROM articles WHERE status = 'published' AND ${inRange('"createdAt"')}) AS published,
        (SELECT COUNT(DISTINCT "userId") FROM article_views WHERE ${inRange('"createdAt"')}) AS "activeReaders"`,
      r,
    );
    return Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, Number(v) || 0]),
    ) as unknown as Metrics;
  }

  async report(period: Period, now = new Date()) {
    const cfg = PERIODS[period];
    if (!cfg) throw new BadRequestException("Davr noto'g'ri");
    const today = new Date(now.getTime() + TASHKENT_OFFSET_MS);
    today.setUTCHours(0, 0, 0, 0);
    const curFrom = new Date(today.getTime() - (cfg.days - 1) * DAY_MS);
    const prevTo = new Date(curFrom.getTime() - DAY_MS);
    const prevFrom = new Date(prevTo.getTime() - (cfg.days - 1) * DAY_MS);

    // Grafik oralig'i: oxirgi `points` ta bo'lak (kun/hafta/oy)
    const seriesFrom =
      cfg.unit === 'day'
        ? new Date(today.getTime() - (cfg.points - 1) * DAY_MS)
        : cfg.unit === 'week'
          ? new Date(today.getTime() - (cfg.points - 1) * 7 * DAY_MS)
          : new Date(
              Date.UTC(
                today.getUTCFullYear(),
                today.getUTCMonth() - (cfg.points - 1),
                1,
              ),
            );

    const [current, previous, series, topArticles, topCategories, totals] =
      await Promise.all([
        this.metrics(ymd(curFrom), ymd(today)),
        this.metrics(ymd(prevFrom), ymd(prevTo)),
        this.series(cfg.unit, ymd(seriesFrom), ymd(today)),
        this.topArticles(ymd(curFrom), ymd(today)),
        this.topCategories(ymd(curFrom), ymd(today)),
        this.totals(),
      ]);

    return {
      period,
      range: { from: ymd(curFrom), to: ymd(today) },
      previousRange: { from: ymd(prevFrom), to: ymd(prevTo) },
      current,
      previous,
      series: { unit: cfg.unit, points: series },
      topArticles,
      topCategories,
      totals,
    };
  }

  private async series(unit: string, from: string, to: string) {
    const bucket = (expr: string) => `date_trunc(:unit, ${expr})::date`;
    const rows = await this.rows<Record<string, string>>(
      `WITH b AS (
         SELECT generate_series(
           date_trunc(:unit, CAST(:from AS date)),
           date_trunc(:unit, CAST(:to AS date)),
           CAST('1 ' || :unit AS interval)
         )::date AS b
       )
       SELECT to_char(b.b, 'YYYY-MM-DD') AS bucket,
         (SELECT COALESCE(SUM(views), 0) FROM daily_views WHERE ${bucket('day')} = b.b) AS views,
         (SELECT COUNT(*) FROM users WHERE ${bucket(local('"createdAt"'))} = b.b) AS "newUsers",
         (SELECT COUNT(*) FROM likes WHERE ${bucket(local('"createdAt"'))} = b.b) AS likes,
         (SELECT COUNT(*) FROM articles WHERE status = 'published' AND ${bucket(local('"createdAt"'))} = b.b) AS published
       FROM b ORDER BY b.b`,
      { unit, from, to },
    );
    return rows.map((r) => ({
      bucket: r.bucket,
      views: Number(r.views) || 0,
      newUsers: Number(r.newUsers) || 0,
      likes: Number(r.likes) || 0,
      published: Number(r.published) || 0,
    }));
  }

  private async topArticles(from: string, to: string) {
    const rows = await this.rows<Record<string, string>>(
      `SELECT a.id, a.title, a.slug, c.name AS category, SUM(dv.views) AS views
       FROM daily_views dv
       JOIN articles a ON a.id = dv."articleId"
       LEFT JOIN categories c ON c.id = a."categoryId"
       WHERE dv.day BETWEEN :from AND :to
       GROUP BY a.id, a.title, a.slug, c.name
       ORDER BY views DESC
       LIMIT 10`,
      { from, to },
    );
    return rows.map((r) => ({
      ...r,
      id: Number(r.id),
      views: Number(r.views),
    }));
  }

  private async topCategories(from: string, to: string) {
    const rows = await this.rows<Record<string, string>>(
      `SELECT c.id, c.name, SUM(dv.views) AS views
       FROM daily_views dv
       JOIN articles a ON a.id = dv."articleId"
       JOIN categories c ON c.id = a."categoryId"
       WHERE dv.day BETWEEN :from AND :to
       GROUP BY c.id, c.name
       ORDER BY views DESC
       LIMIT 8`,
      { from, to },
    );
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      views: Number(r.views),
    }));
  }

  /** Butun davr uchun jami ko'rsatkichlar */
  async totals() {
    const row = await this.one<Record<string, string>>(
      `SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM users WHERE plan = 'premium') AS premium,
        (SELECT COUNT(*) FROM articles WHERE status = 'published') AS articles,
        (SELECT COUNT(*) FROM articles WHERE status = 'draft') AS drafts,
        (SELECT COALESCE(SUM("viewCount"), 0) FROM articles) AS views,
        (SELECT COUNT(*) FROM likes) AS likes,
        (SELECT COUNT(*) FROM comments) AS comments,
        (SELECT COUNT(*) FROM subscribers WHERE "isActive" = true) AS subscribers,
        (SELECT to_char(MIN(day), 'YYYY-MM-DD') FROM daily_views) AS "viewsTrackedSince"`,
    );
    const { viewsTrackedSince, ...nums } = row;
    return {
      ...Object.fromEntries(
        Object.entries(nums).map(([k, v]) => [k, Number(v) || 0]),
      ),
      viewsTrackedSince: viewsTrackedSince ?? null,
    };
  }

  /** Foydalanuvchilar ro'yxati — faollik ko'rsatkichlari bilan */
  async users() {
    const rows = await this.rows<Record<string, any>>(
      `SELECT u.id, u."fullName", u.email, u.role, u.plan, u."premiumExpiresAt",
         u."isActive", u."createdAt",
         (SELECT COUNT(*) FROM article_views v WHERE v."userId" = u.id) AS reads,
         (SELECT COUNT(*) FROM likes l WHERE l."userId" = u.id) AS likes,
         (SELECT COUNT(*) FROM comments c WHERE c."userId" = u.id) AS comments,
         (SELECT COUNT(*) FROM bookmarks b WHERE b."userId" = u.id) AS bookmarks,
         GREATEST(
           (SELECT MAX(v."createdAt") FROM article_views v WHERE v."userId" = u.id),
           (SELECT MAX(l."createdAt") FROM likes l WHERE l."userId" = u.id),
           (SELECT MAX(c."createdAt") FROM comments c WHERE c."userId" = u.id)
         ) AS "lastActiveAt"
       FROM users u
       ORDER BY u."createdAt" DESC`,
    );
    return rows.map((r) => ({
      ...r,
      reads: Number(r.reads) || 0,
      likes: Number(r.likes) || 0,
      comments: Number(r.comments) || 0,
      bookmarks: Number(r.bookmarks) || 0,
    }));
  }
}
