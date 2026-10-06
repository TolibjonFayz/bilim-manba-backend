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
    await this.sequelize.query(
      `CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
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
