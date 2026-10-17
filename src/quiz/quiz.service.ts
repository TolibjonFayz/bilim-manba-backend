import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Article, ArticleStatus } from '../articles/models/article.model';
import { createLlm, Llm } from '../drafts/llm';

export interface QuizQuestion {
  q: string;
  options: string[];
  /** To'g'ri javob indeksi (options ichida) */
  answer: number;
  /** Nega shu javob to'g'ri — bir gap */
  explain: string;
}

const QUESTIONS = 3;
// Eski maqolalarga test tuzish: ishga tushgandan keyin kutish va maqolalar orasidagi tanaffus
// (Gemini bepul tarifi daqiqasiga cheklangan, sayt ishiga xalaqit bermasin)
const BACKFILL_DELAY_MS = 5 * 60 * 1000;
const BACKFILL_GAP_MS = 30 * 1000;
const BACKFILL_MAX_FAILS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Maqola HTML'idan test uchun matn: "Shuningdek o'qing" va "Manbalar"siz */
export function quizText(html: string, max = 12000): string {
  const cut = html.search(/<h2>\s*(Shuningdek o'qing|Manbalar)\s*<\/h2>/i);
  return (cut > 0 ? html.slice(0, cut) : html)
    .replace(/<\/(p|h2|h3|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim()
    .slice(0, max);
}

/**
 * AI javobini tekshiradi: aynan 3 ta savol, har birida 4 ta har xil variant,
 * to'g'ri javob indeksi to'g'ri. Variantlar aralashtiriladi — to'g'ri javob
 * doim bir joyda turmasin.
 */
export function normalizeQuiz(
  raw: unknown,
  rand = Math.random,
): QuizQuestion[] {
  const list = Array.isArray((raw as any)?.questions)
    ? (raw as any).questions
    : [];
  const clean = (s: unknown) =>
    String(s ?? '')
      .replace(/[‘’ʻʼ`]/g, "'")
      .replace(/[“”«»]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  const out: QuizQuestion[] = [];
  for (const item of list) {
    const q = clean(item?.q);
    const options = (Array.isArray(item?.options) ? item.options : []).map(
      clean,
    );
    const answer = Number(item?.answer);
    if (
      !q ||
      options.length !== 4 ||
      options.some((o: string) => !o) ||
      new Set(options.map((o: string) => o.toLowerCase())).size !== 4 ||
      !Number.isInteger(answer) ||
      answer < 0 ||
      answer > 3
    )
      continue;
    const correct = options[answer];
    const shuffled = [...options];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    out.push({
      q: q.slice(0, 300),
      options: shuffled.map((o) => o.slice(0, 160)),
      answer: shuffled.indexOf(correct),
      explain: clean(item?.explain).slice(0, 400),
    });
    if (out.length === QUESTIONS) break;
  }
  return out.length === QUESTIONS ? out : [];
}

/**
 * Maqola oxiridagi "O'zingizni sinang" testi: 3 ta savol, AI maqola matnidan
 * tuzadi. Alohida article_quizzes jadvalida (maqolalar ro'yxati og'irlashmasin).
 *  - maqola chop etilganda tuziladi (PublishingService.afterPublish);
 *  - eski maqolalar uchun server ishga tushgach fonda sekin-asta to'ldiriladi;
 *  - o'quvchilar natijasi (urinishlar, to'g'ri javoblar) shu jadvalda yig'iladi.
 */
@Injectable()
export class QuizService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuizService.name);
  /** Testlar uchun: soxta model */
  llmOverride?: Llm;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private busy = new Set<number>();

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Article) private readonly articleModel: typeof Article,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  onModuleInit() {
    this.timer = setTimeout(() => void this.backfill(), BACKFILL_DELAY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
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

  /** Maqola sahifasi uchun: savollar yoki null */
  async forArticle(articleId: number): Promise<QuizQuestion[] | null> {
    try {
      const rows = await this.sequelize.query<{ questions: any }>(
        'SELECT questions FROM article_quizzes WHERE "articleId" = :id',
        { replacements: { id: articleId }, type: QueryTypes.SELECT },
      );
      const q = rows[0]?.questions;
      const list = typeof q === 'string' ? JSON.parse(q) : q;
      return Array.isArray(list) && list.length ? list : null;
    } catch (err: any) {
      this.logger.warn(`Test o'qilmadi (${articleId}): ${err?.message}`);
      return null;
    }
  }

  /** Maqola matnidan test tuzadi va saqlaydi. Xato bo'lsa — false (sayt ishlayveradi) */
  async generateFor(articleId: number, html?: string): Promise<boolean> {
    if (this.busy.has(articleId)) return false;
    const llm = this.getLlm();
    if (!llm) return false;
    this.busy.add(articleId);
    try {
      const article = await this.articleModel.findByPk(articleId, {
        attributes: ['id', 'title', 'content'],
        raw: true,
      });
      if (!article) return false;
      const body = html ?? (await this.fetchContent(article.content));
      const text = quizText(body ?? '');
      if (text.length < 600) return false;
      const raw = await llm.json(
        `Sen o'zbek tilidagi ilmiy-ommabop jurnal muharririsan. Maqola oxiriga o'quvchilar uchun qiziqarli "O'zingizni sinang" testi tuz.
Qoidalar:
- Aynan ${QUESTIONS} ta savol, faqat maqoladagi ma'lumot asosida (maqolada yo'q narsani so'rama).
- Maqolaning eng muhim va qiziq faktlarini tekshir; mayda raqam yoki sanani yodlatishga emas, tushunishga qaratilgan bo'lsin.
- Har savolda 4 ta variant, faqat bittasi to'g'ri; noto'g'ri variantlar ishonarli, lekin aniq noto'g'ri bo'lsin. "Hammasi to'g'ri" / "Hech biri" variantlarini ishlatma.
- Savol 120 belgidan, variant 70 belgidan qisqa. Lotin yozuvi, o' va g' uchun oddiy apostrof.
- explain: to'g'ri javob nega to'g'ri — bitta qisqa gap.
- Oilaviy auditoriya; Islom qadriyatlariga zid yoki 18+ savol bo'lmasin.
Javob faqat JSON: {"questions": [{"q": "...", "options": ["...", "...", "...", "..."], "answer": 0, "explain": "..."}]}`,
        `Sarlavha: ${article.title}\n\n${text}`,
      );
      const quiz = normalizeQuiz(
        JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)),
      );
      if (!quiz.length) {
        this.logger.warn(`Test yaroqsiz chiqdi (${articleId})`);
        return false;
      }
      await this.sequelize.query(
        `INSERT INTO article_quizzes ("articleId", questions, "createdAt")
         VALUES (:id, CAST(:q AS JSONB), now())
         ON CONFLICT ("articleId") DO UPDATE SET questions = EXCLUDED.questions, "createdAt" = now()`,
        { replacements: { id: articleId, q: JSON.stringify(quiz) } },
      );
      this.logger.log(`Test tuzildi: ${article.title}`);
      return true;
    } catch (err: any) {
      this.logger.warn(`Test tuzilmadi (${articleId}): ${err?.message}`);
      return false;
    } finally {
      this.busy.delete(articleId);
    }
  }

  private async fetchContent(url?: string | null): Promise<string | null> {
    if (!url) return null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const j: any = await res.json();
      return String(j?.message ?? '');
    } catch {
      return null;
    }
  }

  /**
   * Testi yo'q chop etilgan maqolalarga sekin-asta test tuzadi (ko'p
   * o'qilganlardan boshlab). Ketma-ket bir necha xato bo'lsa — to'xtaydi,
   * keyingi ishga tushishda davom etadi.
   */
  async backfill(gapMs = BACKFILL_GAP_MS): Promise<number> {
    if (!this.getLlm()) return 0;
    let done = 0;
    let fails = 0;
    try {
      const rows = await this.sequelize.query<{ id: number }>(
        `SELECT a.id FROM articles a
         LEFT JOIN article_quizzes q ON q."articleId" = a.id
         WHERE a.status = :status AND q."articleId" IS NULL
         ORDER BY a."viewCount" DESC`,
        {
          replacements: { status: ArticleStatus.PUBLISHED },
          type: QueryTypes.SELECT,
        },
      );
      for (const { id } of rows) {
        if (this.stopped) break;
        if (await this.generateFor(id)) {
          done++;
          fails = 0;
        } else if (++fails >= BACKFILL_MAX_FAILS) {
          this.logger.warn(
            `Testlarni to'ldirish to'xtatildi: ketma-ket ${fails} ta xato`,
          );
          break;
        }
        if (gapMs) await sleep(gapMs);
      }
    } catch (err: any) {
      this.logger.warn(`Testlarni to'ldirishda xato: ${err?.message}`);
    }
    if (done) this.logger.log(`Eski maqolalarga ${done} ta test tuzildi`);
    return done;
  }

  /** O'quvchi testni tugatdi: urinishlar va to'g'ri javoblar yig'indisi */
  async recordResult(slug: string, correct: number) {
    const n = Math.round(Number(correct));
    if (!Number.isFinite(n) || n < 0 || n > QUESTIONS) return { ok: false };
    const article = await this.articleModel.findOne({
      where: { slug, status: ArticleStatus.PUBLISHED },
      attributes: ['id'],
    });
    if (!article) throw new NotFoundException('Maqola topilmadi');
    await this.sequelize.query(
      `UPDATE article_quizzes SET attempts = attempts + 1, "correctTotal" = "correctTotal" + :n
       WHERE "articleId" = :id`,
      { replacements: { id: article.id, n } },
    );
    return { ok: true };
  }
}
