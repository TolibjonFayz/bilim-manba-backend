import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { ARTICLE_SOURCE_2026_10 } from './data/article-source-2026-10';

/**
 * Bazaga qo'lda tegmasdan sxema/ma'lumot o'zgarishlarini bajaradi.
 *
 * `synchronize: true` faqat yo'q jadvallarni yaratadi, mavjud jadvalga
 * yangi ustun QO'SHMAYDI. Shuning uchun ustunlar shu yerda
 * `ADD COLUMN IF NOT EXISTS` bilan qo'shiladi (har ishga tushishda, xavfsiz).
 * Ma'lumot migratsiyalari esa `data_migrations` jadvali orqali faqat bir
 * marta bajariladi.
 */
@Injectable()
export class DataMigrationsService implements OnModuleInit {
  private readonly logger = new Logger(DataMigrationsService.name);

  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async onModuleInit() {
    await this.ensureSchema();
    await this.runOnce('2026-10-01-article-source', (t) =>
      this.moveExcerptToSource(t),
    );
  }

  private async ensureSchema() {
    await this.sequelize.query(
      'ALTER TABLE articles ADD COLUMN IF NOT EXISTS "source" VARCHAR(255)',
    );
    await this.sequelize.query(
      'ALTER TABLE articles ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMPTZ',
    );
    await this.sequelize.query(
      'ALTER TABLE articles ADD COLUMN IF NOT EXISTS "telegramPostedAt" TIMESTAMPTZ',
    );
    await this.sequelize.query(
      'ALTER TABLE articles ADD COLUMN IF NOT EXISTS "instagramPostedAt" TIMESTAMPTZ',
    );
    await this.sequelize.query(
      'ALTER TABLE articles ADD COLUMN IF NOT EXISTS "instagramStoryPostedAt" TIMESTAMPTZ',
    );
    // Kunlik ko'rishlar (mehmonlar ham) — statistika hisobotlari uchun.
    // day — Toshkent sanasi
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS daily_views (
        "articleId" INTEGER NOT NULL,
        day DATE NOT NULL,
        views INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY ("articleId", day)
      )`,
    );
    await this.sequelize.query(
      'CREATE INDEX IF NOT EXISTS daily_views_day_idx ON daily_views (day)',
    );
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
    // Maktab o'quvchilari uchun maqolalar (SchoolService): fan va sinf
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS school_articles (
        "articleId" INTEGER PRIMARY KEY,
        subject VARCHAR(60) NOT NULL,
        grade INTEGER,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
    // Admin /maktab'dan olib tashlagan maqola — qator qoladi, AI qayta belgilamaydi
    await this.sequelize.query(
      'ALTER TABLE school_articles ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false',
    );
    // Maqolalar seriyasi (SeriesService): bir maqola — ko'pi bilan bitta seriyada
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS series (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        slug VARCHAR(200) NOT NULL UNIQUE,
        description TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS series_articles (
        "articleId" INTEGER PRIMARY KEY,
        "seriesId" INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
        position INTEGER NOT NULL
      )`,
    );
    await this.sequelize.query(
      'CREATE INDEX IF NOT EXISTS series_articles_series_idx ON series_articles ("seriesId", position)',
    );
    // Maqola oxiridagi test (QuizService) va o'quvchilar natijasi
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS article_quizzes (
        "articleId" INTEGER PRIMARY KEY,
        questions JSONB NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        "correctTotal" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
    // AI qoralamalar fakt-tekshiruvi (FactCheckService): shubhali joylar va manbalar matni
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS fact_checks (
        "articleId" INTEGER PRIMARY KEY,
        state VARCHAR(20) NOT NULL,
        issues JSONB,
        sources TEXT,
        error TEXT,
        "checkedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
    // Test ballari (QuizPointsService): har foydalanuvchiga har test uchun bir marta
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS quiz_scores (
        "userId" INTEGER NOT NULL,
        "articleId" INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        total INTEGER NOT NULL,
        points INTEGER NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("userId", "articleId")
      )`,
    );
    await this.sequelize.query(
      'CREATE INDEX IF NOT EXISTS quiz_scores_created_idx ON quiz_scores ("createdAt")',
    );
    // Test javoblari serverda tekshiriladi (QuizService.check): kirgan
    // foydalanuvchining har savoldagi BIRINCHI tanlovi — ball shundan hisoblanadi
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS quiz_picks (
        "userId" INTEGER NOT NULL,
        "articleId" INTEGER NOT NULL,
        idx SMALLINT NOT NULL,
        choice SMALLINT NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("userId", "articleId", idx)
      )`,
    );
    // Saytning o'z statistikasi (AnalyticsService): tashriflar va hodisalar
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS analytics_sessions (
        id VARCHAR(40) PRIMARY KEY,
        "visitorId" VARCHAR(40) NOT NULL,
        "userId" INTEGER,
        "startedAt" TIMESTAMPTZ NOT NULL,
        "lastAt" TIMESTAMPTZ NOT NULL,
        "landingPath" VARCHAR(300),
        referrer VARCHAR(500),
        "source" VARCHAR(60),
        "utmSource" VARCHAR(60),
        "utmMedium" VARCHAR(60),
        "utmCampaign" VARCHAR(100),
        device VARCHAR(20),
        os VARCHAR(20),
        browser VARCHAR(30),
        country VARCHAR(4),
        "screen" VARCHAR(20),
        pageviews INTEGER NOT NULL DEFAULT 0,
        events INTEGER NOT NULL DEFAULT 0,
        "activeSeconds" INTEGER NOT NULL DEFAULT 0,
        "isNew" BOOLEAN NOT NULL DEFAULT true
      )`,
    );
    await this.sequelize.query(
      'CREATE INDEX IF NOT EXISTS analytics_sessions_started_idx ON analytics_sessions ("startedAt")',
    );
    await this.sequelize.query(
      'CREATE INDEX IF NOT EXISTS analytics_sessions_visitor_idx ON analytics_sessions ("visitorId")',
    );
    await this.sequelize.query(
      'CREATE INDEX IF NOT EXISTS analytics_sessions_last_idx ON analytics_sessions ("lastAt")',
    );
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS analytics_events (
        id BIGSERIAL PRIMARY KEY,
        "visitorId" VARCHAR(40) NOT NULL,
        "sessionId" VARCHAR(40) NOT NULL,
        "userId" INTEGER,
        type VARCHAR(40) NOT NULL,
        path VARCHAR(300),
        data JSONB,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
    await this.sequelize.query(
      'CREATE INDEX IF NOT EXISTS analytics_events_type_created_idx ON analytics_events (type, "createdAt")',
    );
    await this.sequelize.query(
      'CREATE INDEX IF NOT EXISTS analytics_events_session_idx ON analytics_events ("sessionId", "createdAt")',
    );
    await this.sequelize.query(
      'CREATE INDEX IF NOT EXISTS analytics_events_created_idx ON analytics_events ("createdAt")',
    );
    // Email qaysi formada (ro'yxatdan o'tish / pastdagi obuna ...) va qaysi sahifada kiritilgan
    await this.sequelize.query(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMPTZ',
    );
    await this.sequelize.query(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMPTZ',
    );
    await this.sequelize.query(
      'ALTER TABLE articles ADD COLUMN IF NOT EXISTS attachments JSONB',
    );
    for (const table of ['users', 'subscribers']) {
      await this.sequelize.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "signupSource" VARCHAR(60)`,
      );
      await this.sequelize.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "signupPath" VARCHAR(300)`,
      );
    }
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS data_migrations (
        id VARCHAR(255) PRIMARY KEY,
        "ranAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
  }

  private async runOnce(id: string, fn: (t: any) => Promise<string>) {
    await this.sequelize.transaction(async (t) => {
      // Ikki instance bir vaqtda ishga tushsa ham faqat bittasi bajaradi
      await this.sequelize.query(
        'LOCK TABLE data_migrations IN EXCLUSIVE MODE',
        { transaction: t },
      );
      const done = await this.sequelize.query(
        'SELECT 1 FROM data_migrations WHERE id = :id',
        { replacements: { id }, type: QueryTypes.SELECT, transaction: t },
      );
      if (done.length) return;

      const summary = await fn(t);
      await this.sequelize.query(
        'INSERT INTO data_migrations (id) VALUES (:id)',
        { replacements: { id }, transaction: t },
      );
      this.logger.log(`Migratsiya ${id}: ${summary}`);
    });
  }

  /**
   * Avval `excerpt` maydonida manba nomi saqlanardi ("Claude AI",
   * "The Athletic (Michael Cox)"). Manbani `source` ga ko'chiramiz va
   * `excerpt` ga haqiqiy qisqa tavsif yozamiz.
   */
  private async moveExcerptToSource(t: any): Promise<string> {
    let updated = 0;
    for (const row of ARTICLE_SOURCE_2026_10) {
      // excerpt hali eski qiymatda bo'lsagina yangilanadi — admin shu orada
      // qo'lda o'zgartirgan maqolalar ustidan yozib yuborilmaydi
      const [, meta]: any = await this.sequelize.query(
        `UPDATE articles SET "source" = :source, excerpt = :excerpt
         WHERE slug = :slug AND excerpt = :oldExcerpt AND "source" IS NULL`,
        { replacements: row, transaction: t },
      );
      updated += meta?.rowCount ?? 0;
    }

    // Ro'yxatda yo'q maqolalar (masalan, qoralamalar): excerpt manba nomiga
    // o'xshasa (qisqa, gap bilan tugamaydi) — source ga ko'chiriladi,
    // tavsif bo'sh qoladi, sayt uni matndan oladi
    const [, rest]: any = await this.sequelize.query(
      `UPDATE articles SET "source" = excerpt, excerpt = NULL
       WHERE "source" IS NULL AND excerpt IS NOT NULL
         AND length(excerpt) <= 100 AND excerpt !~ '[.!?…]\\s*$'`,
      { transaction: t },
    );

    return `${updated}/${ARTICLE_SOURCE_2026_10.length} maqola yangilandi, ${rest?.rowCount ?? 0} ta qolgani source ga ko'chirildi`;
  }
}
