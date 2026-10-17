import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { createLlm, Llm } from '../drafts/llm';
import { findSource } from '../drafts/wikipedia';

export interface SeriesPart {
  id: number;
  title: string;
  slug: string;
  position: number;
  excerpt?: string | null;
  coverImage?: string | null;
  status?: string;
}

/** Kunlik navbatdagi seriya qismi: navbatdagi mavzu → qaysi seriyaning nechanchi qismi */
interface QueuedPart {
  seriesId: number;
  position: number;
  title: string;
}

const QUEUE_KEY = 'series_queue';

const slugify = (s: string) =>
  String(s ?? '')
    .replace(/[‘’ʻʼ`']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '') || `seriya-${Date.now()}`;

const clean = (s: unknown, max: number) =>
  String(s ?? '')
    .replace(/[‘’ʻʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * Maqolalar seriyasi: bir mavzudagi ketma-ket qismlar ("Koinot sirlari: 1-qism…").
 * Jadvallar: series, series_articles (bir maqola — ko'pi bilan bitta seriyada).
 * O'quvchiga faqat chop etilgan qismlar ko'rinadi.
 *
 * AI reja: admin seriya mavzusini beradi → AI 3–6 qismli reja tuzadi (har qism
 * uchun Wikipedia mavzusi) → qismlar kunlik AI navbatiga qo'shiladi; qoralama
 * yozilgach u avtomatik seriyaga (o'z o'rniga) biriktiriladi.
 */
@Injectable()
export class SeriesService {
  private readonly logger = new Logger(SeriesService.name);
  /** Testlar uchun: soxta model */
  llmOverride?: Llm;

  constructor(
    private readonly config: ConfigService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  private q<T extends object = any>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      replacements,
      type: QueryTypes.SELECT,
    });
  }

  private exec(sql: string, replacements: Record<string, unknown> = {}) {
    return this.sequelize.query(sql, { replacements });
  }

  private async getSetting(key: string): Promise<string | null> {
    const rows = await this.q<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = :key',
      { key },
    );
    return rows[0]?.value ?? null;
  }

  private async setSetting(key: string, value: string) {
    await this.exec(
      `INSERT INTO app_settings (key, value, "updatedAt") VALUES (:key, :value, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      { key, value },
    );
  }

  private getLlm(): Llm | null {
    return (
      this.llmOverride ??
      createLlm({
        geminiKey: this.config.get<string>('GEMINI_API_KEY'),
        geminiModel: this.config.get<string>('GEMINI_MODEL'),
        geminiFallbacks: this.config.get<string>('GEMINI_FALLBACK_MODELS'),
        groqKey: this.config.get<string>('GROQ_API_KEY'),
        groqModel: this.config.get<string>('GROQ_MODEL'),
      })
    );
  }

  // ---------- Ochiq (o'quvchilar uchun) ----------

  /** Kamida bitta chop etilgan qismi bor seriyalar */
  async listPublic() {
    return this.q(
      `SELECT s.id, s.title, s.slug, s.description, s."updatedAt",
              COUNT(a.id)::int AS "partCount",
              (ARRAY_AGG(a."coverImage" ORDER BY sa.position) FILTER (WHERE a."coverImage" IS NOT NULL))[1] AS "coverImage"
       FROM series s
       JOIN series_articles sa ON sa."seriesId" = s.id
       JOIN articles a ON a.id = sa."articleId" AND a.status = 'published'
       GROUP BY s.id
       ORDER BY MAX(a."createdAt") DESC`,
    );
  }

  async bySlug(slug: string) {
    const [series] = await this.q(
      'SELECT id, title, slug, description, "updatedAt" FROM series WHERE slug = :slug',
      { slug },
    );
    if (!series) throw new NotFoundException('Seriya topilmadi');
    const parts = await this.parts(series.id, true);
    if (!parts.length) throw new NotFoundException('Seriya topilmadi');
    return { ...series, parts };
  }

  private parts(seriesId: number, publishedOnly: boolean) {
    return this.q<SeriesPart>(
      `SELECT a.id, a.title, a.slug, a.excerpt, a."coverImage", a.status, sa.position
       FROM series_articles sa JOIN articles a ON a.id = sa."articleId"
       WHERE sa."seriesId" = :id ${publishedOnly ? "AND a.status = 'published'" : ''}
       ORDER BY sa.position, a."createdAt"`,
      { id: seriesId },
    );
  }

  /** Maqola sahifasi uchun: seriya, shu qismning tartib raqami va boshqa qismlar */
  async forArticle(articleId: number) {
    try {
      const [link] = await this.q<{ seriesId: number }>(
        'SELECT "seriesId" FROM series_articles WHERE "articleId" = :id',
        { id: articleId },
      );
      if (!link) return null;
      const [series] = await this.q(
        'SELECT id, title, slug FROM series WHERE id = :id',
        { id: link.seriesId },
      );
      const parts = (await this.parts(link.seriesId, true)).map(
        ({ id, title, slug }) => ({ id, title, slug }),
      );
      const index = parts.findIndex((p) => p.id === articleId);
      if (!series || index < 0 || parts.length < 2) return null;
      return {
        title: series.title,
        slug: series.slug,
        part: index + 1,
        total: parts.length,
        parts,
      };
    } catch (err: any) {
      this.logger.warn(`Seriya o'qilmadi (${articleId}): ${err?.message}`);
      return null;
    }
  }

  async sitemap() {
    return this.q(
      `SELECT DISTINCT s.slug, s."updatedAt" FROM series s
       JOIN series_articles sa ON sa."seriesId" = s.id
       JOIN articles a ON a.id = sa."articleId" AND a.status = 'published'`,
    );
  }

  // ---------- Admin ----------

  async adminList() {
    const series = await this.q(
      'SELECT id, title, slug, description, "createdAt" FROM series ORDER BY "createdAt" DESC',
    );
    const queue = await this.queue();
    const topics = await this.queueTopics();
    for (const s of series) {
      s.parts = await this.parts(s.id, false);
      // Navbatdagi (hali yozilmagan) qismlar — navbatda qolganlari
      s.queued = Object.entries(queue)
        .filter(([t, v]) => v.seriesId === s.id && topics.has(t))
        .map(([topic, v]) => ({ topic, title: v.title, position: v.position }))
        .sort((a, b) => a.position - b.position);
    }
    return series;
  }

  private async uniqueSlug(title: string, exceptId?: number) {
    const base = slugify(title);
    for (let i = 1; i < 50; i++) {
      const slug = i === 1 ? base : `${base}-${i}`;
      const [hit] = await this.q('SELECT id FROM series WHERE slug = :slug', {
        slug,
      });
      if (!hit || hit.id === exceptId) return slug;
    }
    return `${base}-${Date.now()}`;
  }

  async create(dto: { title?: string; description?: string }) {
    const title = clean(dto?.title, 150);
    if (!title) throw new BadRequestException('Seriya nomi kerak');
    const slug = await this.uniqueSlug(title);
    const [row] = await this.q(
      `INSERT INTO series (title, slug, description, "createdAt", "updatedAt")
       VALUES (:title, :slug, :description, now(), now()) RETURNING id, title, slug, description`,
      { title, slug, description: clean(dto?.description, 600) || null },
    );
    return row;
  }

  /** Nom/tavsif va qismlar tartibi (articleIds — tartib bo'yicha) */
  async update(
    id: number,
    dto: { title?: string; description?: string; articleIds?: unknown },
  ) {
    const [series] = await this.q('SELECT id FROM series WHERE id = :id', {
      id,
    });
    if (!series) throw new NotFoundException('Seriya topilmadi');
    if (dto?.title !== undefined) {
      const title = clean(dto.title, 150);
      if (!title) throw new BadRequestException('Seriya nomi kerak');
      await this.exec(
        'UPDATE series SET title = :title, slug = :slug, "updatedAt" = now() WHERE id = :id',
        { id, title, slug: await this.uniqueSlug(title, id) },
      );
    }
    if (dto?.description !== undefined) {
      await this.exec(
        'UPDATE series SET description = :d, "updatedAt" = now() WHERE id = :id',
        { id, d: clean(dto.description, 600) || null },
      );
    }
    if (Array.isArray(dto?.articleIds)) {
      const ids = [
        ...new Set(dto.articleIds.map(Number).filter(Number.isInteger)),
      ];
      await this.sequelize.transaction(async (transaction) => {
        await this.sequelize.query(
          'DELETE FROM series_articles WHERE "seriesId" = :id',
          { replacements: { id }, transaction },
        );
        for (const [i, articleId] of ids.entries()) {
          // Boshqa seriyada bo'lsa — shu seriyaga ko'chadi
          await this.sequelize.query(
            `INSERT INTO series_articles ("articleId", "seriesId", position) VALUES (:a, :s, :p)
             ON CONFLICT ("articleId") DO UPDATE SET "seriesId" = EXCLUDED."seriesId", position = EXCLUDED.position`,
            { replacements: { a: articleId, s: id, p: i + 1 }, transaction },
          );
        }
        await this.sequelize.query(
          'UPDATE series SET "updatedAt" = now() WHERE id = :id',
          { replacements: { id }, transaction },
        );
      });
    }
    return (await this.adminList()).find((s) => s.id === id);
  }

  async remove(id: number) {
    await this.exec('DELETE FROM series_articles WHERE "seriesId" = :id', {
      id,
    });
    await this.exec('DELETE FROM series WHERE id = :id', { id });
    const queue = await this.queue();
    for (const [t, v] of Object.entries(queue))
      if (v.seriesId === id) delete queue[t];
    await this.setSetting(QUEUE_KEY, JSON.stringify(queue));
    return { ok: true };
  }

  // ---------- AI reja va kunlik navbat ----------

  /** AI seriya rejasi: qismlar (o'zbekcha nom + Wikipedia mavzusi). Saqlanmaydi */
  async plan(id: number, partsCount = 4) {
    const [series] = await this.q(
      'SELECT id, title, description FROM series WHERE id = :id',
      { id },
    );
    if (!series) throw new NotFoundException('Seriya topilmadi');
    const llm = this.getLlm();
    if (!llm) {
      throw new ServiceUnavailableException(
        'AI kaliti sozlanmagan (GEMINI_API_KEY yoki GROQ_API_KEY)',
      );
    }
    const n = Math.min(6, Math.max(3, Math.round(Number(partsCount) || 4)));
    const existing = (await this.parts(id, false)).map((p) => p.title);
    let parts: { title: string; topic: string }[] = [];
    try {
      const raw = await llm.json(
        `Sen Bilim Manba (o'zbek tilidagi ilmiy-ommabop sayt) bosh muharririsan. Ketma-ket o'qiladigan maqolalar seriyasini rejalashtirasan.
Seriya: "${series.title}"${series.description ? ` — ${series.description}` : ''}.
${n} ta qism tuz: har qism alohida, aniq mavzu; mantiqiy tartibda (oddiydan murakkabga yoki xronologik), har biri oldingisini davom ettirsin; qismlar bir-birini takrorlamasin.
Har qism uchun: title — o'zbekcha qisqa qism nomi (60 belgigacha, "1-qism" so'zisiz); topic — shu qismni yorituvchi INGLIZCHA Wikipedia maqolasining aynan nomi.
Mavzular musulmon oila o'quvchisiga mos bo'lsin: 18+, spirtli ichimlik, qimor, okkultizm, LGBT, dinni tanqid qilish mavzulari bo'lmasin.
${existing.length ? `Seriyada allaqachon bor qismlar (takrorlama, davomini rejalashtir):\n${existing.map((t) => `- ${t}`).join('\n')}\n` : ''}Javob faqat JSON: {"parts": [{"title": "...", "topic": "..."}]}`,
        series.title,
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      parts = (Array.isArray(j?.parts) ? j.parts : [])
        .map((p: any) => ({
          title: clean(p?.title, 80),
          topic: clean(p?.topic, 200),
        }))
        .filter((p: { title: string; topic: string }) => p.title && p.topic)
        .slice(0, n);
    } catch (err: any) {
      throw new ServiceUnavailableException(
        `AI seriya rejasini tuza olmadi: ${String(err?.message ?? '').slice(0, 200)}`,
      );
    }
    if (!parts.length) {
      throw new ServiceUnavailableException(
        "AI bo'sh reja qaytardi — qayta urinib ko'ring",
      );
    }
    // Wikipedia'da bor-yo'qligi (yo'g'i navbatga qo'yilsa ham yozilmaydi)
    const checked = await Promise.all(
      parts.map(async (p) => {
        try {
          const src = await findSource(p.topic, 300);
          return { ...p, topic: src.title, found: true };
        } catch {
          return { ...p, found: false };
        }
      }),
    );
    return { parts: checked };
  }

  private async queue(): Promise<Record<string, QueuedPart>> {
    try {
      const v = JSON.parse((await this.getSetting(QUEUE_KEY)) ?? '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  private async queueTopics(): Promise<Set<string>> {
    try {
      const v = JSON.parse((await this.getSetting('ai_topics')) ?? '[]');
      return new Set(
        (Array.isArray(v) ? v : []).map((t) => String(t).toLowerCase()),
      );
    } catch {
      return new Set();
    }
  }

  /**
   * Reja qismlarini kunlik AI navbatining oxiriga qo'shadi va ularni seriyaga
   * bog'lab qo'yadi (yozilgach attachQueued biriktiradi).
   */
  async enqueue(id: number, parts: unknown) {
    const [series] = await this.q('SELECT id FROM series WHERE id = :id', {
      id,
    });
    if (!series) throw new NotFoundException('Seriya topilmadi');
    const list = (Array.isArray(parts) ? parts : [])
      .map((p: any) => ({
        title: clean(p?.title, 80),
        topic: clean(p?.topic, 200),
      }))
      .filter((p) => p.topic)
      .slice(0, 6);
    if (!list.length) throw new BadRequestException("Qismlar ro'yxati bo'sh");

    const [{ max }] = await this.q<{ max: number | null }>(
      'SELECT MAX(position) AS max FROM series_articles WHERE "seriesId" = :id',
      { id },
    );
    const queue = await this.queue();
    let pos =
      Math.max(
        Number(max) || 0,
        ...Object.values(queue)
          .filter((v) => v.seriesId === id)
          .map((v) => v.position),
      ) + 1;
    let topics: string[] = [];
    try {
      const v = JSON.parse((await this.getSetting('ai_topics')) ?? '[]');
      topics = Array.isArray(v) ? v.map(String) : [];
    } catch {
      topics = [];
    }
    for (const p of list) {
      const key = p.topic.toLowerCase();
      if (!topics.some((t) => t.toLowerCase() === key)) topics.push(p.topic);
      queue[key] = { seriesId: id, position: pos++, title: p.title };
    }
    await this.setSetting('ai_topics', JSON.stringify(topics.slice(0, 100)));
    await this.setSetting(QUEUE_KEY, JSON.stringify(queue));
    return { topics, added: list.length };
  }

  /** AI qoralama yozildi: mavzu seriya navbatida bo'lsa — seriyaga biriktiriladi */
  async attachQueued(topic: string | undefined, articleId: number) {
    if (!topic) return false;
    try {
      const queue = await this.queue();
      const key = topic.trim().toLowerCase();
      const hit = queue[key];
      if (!hit) return false;
      const [series] = await this.q('SELECT id FROM series WHERE id = :id', {
        id: hit.seriesId,
      });
      delete queue[key];
      await this.setSetting(QUEUE_KEY, JSON.stringify(queue));
      if (!series) return false;
      await this.exec(
        `INSERT INTO series_articles ("articleId", "seriesId", position) VALUES (:a, :s, :p)
         ON CONFLICT ("articleId") DO UPDATE SET "seriesId" = EXCLUDED."seriesId", position = EXCLUDED.position`,
        { a: articleId, s: hit.seriesId, p: hit.position },
      );
      this.logger.log(
        `Qoralama seriyaga biriktirildi: seriya ${hit.seriesId}, ${hit.position}-qism`,
      );
      return true;
    } catch (err: any) {
      this.logger.warn(`Seriyaga biriktirilmadi: ${err?.message}`);
      return false;
    }
  }
}
