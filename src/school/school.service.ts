import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { createLlm, Llm } from '../drafts/llm';

/** Maktab navbatidagi mavzu: Wikipedia nomi + o'zbekcha nom, fan (bo'lim) va sinf */
export interface SchoolTopic {
  topic: string;
  title: string;
  subject: string;
  grade: number | null;
}

const QUEUE_KEY = 'school_queue';
const USED_KEY = 'school_used';
// Navbat tugaganda AI bir yo'la shuncha yangi mavzu taklif qiladi
const REFILL = 20;

const clean = (s: unknown, max: number) =>
  String(s ?? '')
    .replace(/[‘’ʻʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const gradeOf = (g: unknown): number | null => {
  const n = Math.round(Number(g));
  return Number.isFinite(n) && n >= 1 && n <= 11 ? n : null;
};

/**
 * Maktab o'quvchilari uchun maqolalar: O'zbekiston maktab dasturidagi
 * mavzular (fan va sinf bilan). Jadval school_articles — qaysi maqola qaysi
 * fan va sinf uchun. /maktab sahifasi va maqoladagi "O'quvchilar uchun" belgisi.
 *
 * Kunlik AI qoralama navbat bilan shu manbadan ham yozadi (DraftsService):
 * mavzu school_queue'dan olinadi, tugasa AI yangilarini taklif qiladi.
 */
@Injectable()
export class SchoolService {
  private readonly logger = new Logger(SchoolService.name);
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

  private async getJson<T>(key: string, fallback: T): Promise<T> {
    try {
      const [row] = await this.q<{ value: string }>(
        'SELECT value FROM app_settings WHERE key = :key',
        { key },
      );
      return row ? (JSON.parse(row.value) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private async setJson(key: string, value: unknown) {
    await this.exec(
      `INSERT INTO app_settings (key, value, "updatedAt") VALUES (:key, :value, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      { key, value: JSON.stringify(value) },
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

  // ---------- Ochiq ----------

  /** /maktab sahifasi: chop etilgan maktab maqolalari (yangilari birinchi) */
  async listPublic() {
    return this.q(
      `SELECT a.id, a.title, a.slug, a.excerpt, a."coverImage", a."createdAt",
              s.subject, s.grade
       FROM school_articles s JOIN articles a ON a.id = s."articleId"
       WHERE a.status = 'published' AND NOT s.hidden
       ORDER BY a."createdAt" DESC`,
    );
  }

  /** Maqola sahifasidagi belgi uchun: {subject, grade} yoki null */
  async forArticle(articleId: number) {
    try {
      const [row] = await this.q<{ subject: string; grade: number | null }>(
        'SELECT subject, grade FROM school_articles WHERE "articleId" = :id AND NOT hidden',
        { id: articleId },
      );
      return row ?? null;
    } catch {
      return null;
    }
  }

  async mark(articleId: number, subject: string, grade: number | null) {
    await this.exec(
      `INSERT INTO school_articles ("articleId", subject, grade, "createdAt")
       VALUES (:id, :subject, :grade, now())
       ON CONFLICT ("articleId") DO UPDATE SET subject = EXCLUDED.subject, grade = EXCLUDED.grade`,
      { id: articleId, subject: clean(subject, 60) || 'Umumiy', grade },
    );
  }

  // ---------- Admin ----------

  /**
   * Admin ro'yxati: belgilangan hamma maqolalar (yashirilganlari ham).
   * Yashirilgani /maktab'da va maqoladagi belgida chiqmaydi, AI uni qayta
   * belgilamaydi (qator saqlanadi).
   */
  async adminList() {
    return this.q(
      `SELECT a.id, a.title, a.slug, a.status, c.name AS category,
              s.subject, s.grade, s.hidden, s."createdAt"
       FROM school_articles s JOIN articles a ON a.id = s."articleId"
       LEFT JOIN categories c ON c.id = a."categoryId"
       ORDER BY s.hidden, a."createdAt" DESC`,
    );
  }

  /** Admin: fan, sinf yoki yashirish/qaytarish; yangi maqola bo'lsa — qo'shadi */
  async adminSave(
    articleId: number,
    body: { subject?: unknown; grade?: unknown; hidden?: unknown },
  ) {
    const [article] = await this.q<{ id: number }>(
      'SELECT id FROM articles WHERE id = :id',
      { id: articleId },
    );
    if (!article) throw new NotFoundException('Maqola topilmadi');
    const [cur] = await this.q<{
      subject: string;
      grade: number | null;
      hidden: boolean;
    }>(
      'SELECT subject, grade, hidden FROM school_articles WHERE "articleId" = :id',
      { id: articleId },
    );
    const subject =
      body.subject !== undefined ? clean(body.subject, 60) : cur?.subject;
    if (!subject) throw new BadRequestException('Fan nomini kiriting');
    const grade =
      body.grade !== undefined ? gradeOf(body.grade) : (cur?.grade ?? null);
    const hidden =
      body.hidden !== undefined ? Boolean(body.hidden) : (cur?.hidden ?? false);
    await this.exec(
      `INSERT INTO school_articles ("articleId", subject, grade, hidden, "createdAt")
       VALUES (:id, :subject, :grade, :hidden, now())
       ON CONFLICT ("articleId") DO UPDATE
         SET subject = EXCLUDED.subject, grade = EXCLUDED.grade, hidden = EXCLUDED.hidden`,
      { id: articleId, subject, grade, hidden },
    );
    return { articleId, subject, grade, hidden };
  }

  // ---------- Maktab mavzulari navbati ----------

  async queue(): Promise<SchoolTopic[]> {
    const v = await this.getJson<unknown>(QUEUE_KEY, []);
    return Array.isArray(v) ? (v as SchoolTopic[]) : [];
  }

  /**
   * Navbatdagi maktab mavzusi (olib tashlanadi va "ishlatilgan"ga yoziladi).
   * Navbat bo'sh bo'lsa — AI maktab dasturidan yangi mavzular taklif qiladi.
   */
  async nextTopic(): Promise<SchoolTopic | null> {
    let list = await this.queue();
    if (!list.length) {
      list = await this.refill();
      if (!list.length) return null;
    }
    const [next, ...rest] = list;
    await this.setJson(QUEUE_KEY, rest);
    const used = await this.getJson<string[]>(USED_KEY, []);
    used.push(next.topic.toLowerCase());
    await this.setJson(USED_KEY, used.slice(-1000));
    return next;
  }

  /** AI maktab dasturidan saytda hali yo'q mavzular ro'yxatini tuzadi */
  async refill(count = REFILL): Promise<SchoolTopic[]> {
    const llm = this.getLlm();
    if (!llm) return [];
    const [categories, existing, used] = await Promise.all([
      this.q<{ name: string }>('SELECT name FROM categories ORDER BY id'),
      this.q<{ title: string }>(
        'SELECT title FROM articles ORDER BY "createdAt" DESC LIMIT 200',
      ),
      this.getJson<string[]>(USED_KEY, []),
    ]);
    const subjects = categories.map((c) => c.name);
    let list: SchoolTopic[] = [];
    try {
      const raw = await llm.json(
        `Sen O'zbekiston umumta'lim maktablari uchun ilmiy-ommabop maqolalar rejalashtiruvchi tajribali o'qituvchisan.
5–11-sinflar dasturida o'tiladigan, o'quvchilar uy vazifasi va imtihonga tayyorlanishda Google'dan ko'p qidiradigan ${count} ta mavzu tanla (tarix, biologiya, fizika, kimyo, geografiya, matematika, informatika va h.k.).
Har mavzu uchun:
- title — o'zbekcha mavzu nomi, darslikdagidek (masalan: "Fotosintez", "Amir Temur davlati", "Nyutonning harakat qonunlari");
- topic — shu mavzuni yorituvchi INGLIZCHA Wikipedia maqolasining aynan nomi;
- subject — saytdagi bo'limlardan biri: ${subjects.join(', ')};
- grade — odatda o'tiladigan sinf (5–11).
Fanlar va sinflar aralash bo'lsin; saytda bor maqolalarni va avval ishlatilgan mavzularni takrorlama. Musulmon oila o'quvchisiga mos bo'lsin.
Saytdagi maqolalar:
${existing.map((a) => `- ${a.title}`).join('\n')}
Avval ishlatilgan mavzular: ${used.slice(-150).join('; ') || "yo'q"}
Javob faqat JSON: {"topics": [{"title": "...", "topic": "...", "subject": "...", "grade": 7}]}`,
        'Maktab mavzulari',
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      const seen = new Set(used);
      list = (Array.isArray(j?.topics) ? j.topics : [])
        .map((t: any) => ({
          title: clean(t?.title, 120),
          topic: clean(t?.topic, 200),
          subject:
            subjects.find(
              (s) => s.toLowerCase() === clean(t?.subject, 60).toLowerCase(),
            ) ?? '',
          grade: gradeOf(t?.grade),
        }))
        .filter((t: SchoolTopic) => {
          const k = t.topic.toLowerCase();
          if (!t.topic || !t.title || !t.subject || seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, count);
    } catch (err: any) {
      this.logger.warn(`Maktab mavzulari tuzilmadi: ${err?.message}`);
      return [];
    }
    await this.setJson(QUEUE_KEY, list);
    this.logger.log(`Maktab navbati to'ldirildi: ${list.length} ta mavzu`);
    return list;
  }

  /**
   * Mavjud chop etilgan maqolalardan maktab o'quvchilariga mosini AI belgilaydi
   * (fan va sinf bilan). Mos bo'lmasa — belgilamaydi.
   */
  async classifyExisting(max = 20) {
    const llm = this.getLlm();
    if (!llm) return [];
    const pool = await this.q<{
      id: number;
      title: string;
      excerpt: string | null;
      category: string | null;
    }>(
      `SELECT a.id, a.title, a.excerpt, c.name AS category FROM articles a
       LEFT JOIN categories c ON c.id = a."categoryId"
       LEFT JOIN school_articles s ON s."articleId" = a.id
       WHERE a.status = 'published' AND s."articleId" IS NULL
       ORDER BY a."createdAt" DESC LIMIT 200`,
    );
    if (!pool.length) return [];
    let picks: { n: number; subject: string; grade: number | null }[] = [];
    try {
      const raw = await llm.json(
        `Sen O'zbekiston maktab o'qituvchisisan. Ro'yxatdagi maqolalardan maktab o'quvchilariga (5–11-sinf) dars mavzusini tushunish yoki uy vazifasi uchun FOYDALI bo'ladiganlarini tanla: maktab dasturidagi fan mavzusiga (tarix, biologiya, fizika, kimyo, geografiya, matematika, informatika, adabiyot) bevosita tegishli bo'lsin.
Tanlama: sport yangiliklari, film va o'yin sharhlari, mashhurlar haqidagi maqolalar, dasturdan uzoq tor mavzular. Eng ko'pi ${max} ta; mosi kam bo'lsa — kamroq.
Har biri uchun: n (raqam), subject (fan nomi o'zbekcha, masalan "Biologiya"), grade (odatda o'tiladigan sinf 5–11).
Javob faqat JSON: {"picks": [{"n": 0, "subject": "...", "grade": 8}]}`,
        pool
          .map(
            (a, i) =>
              `${i}) [${a.category ?? '-'}] ${a.title} — ${String(a.excerpt ?? '').slice(0, 120)}`,
          )
          .join('\n'),
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      picks = (Array.isArray(j?.picks) ? j.picks : []).map((p: any) => ({
        n: Number(p?.n),
        subject: clean(p?.subject, 60),
        grade: gradeOf(p?.grade),
      }));
    } catch (err: any) {
      this.logger.warn(`Mavjud maqolalar belgilanmadi: ${err?.message}`);
      return [];
    }
    const done: { id: number; title: string }[] = [];
    const seen = new Set<number>();
    for (const p of picks) {
      if (!Number.isInteger(p.n) || !pool[p.n] || seen.has(p.n) || !p.subject)
        continue;
      seen.add(p.n);
      await this.mark(pool[p.n].id, p.subject, p.grade);
      done.push({ id: pool[p.n].id, title: pool[p.n].title });
      if (done.length >= max) break;
    }
    if (done.length)
      this.logger.log(`Maktab uchun belgilandi: ${done.length} ta maqola`);
    return done;
  }
}
