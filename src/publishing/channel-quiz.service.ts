import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QuizQuestion } from '../quiz/quiz.service';
import { TelegramService } from './telegram.service';

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
// Kechqurun — kanal a'zolari eng faol payt
const DEFAULT_HOUR = 19;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
// Server ishga tushgach birinchi tekshiruv (deploy paytida shoshilmasin)
const BOOT_DELAY_MS = 2 * 60 * 1000;
// Telegram cheklovlari: savol 300, variant 100, izoh 200 belgi
const Q_MAX = 300;
const OPT_MAX = 100;
const EXPLAIN_MAX = 200;
const PREFIX = '🧠 Kun savoli: ';

const K = {
  enabled: 'tg_quiz_daily',
  hour: 'tg_quiz_hour',
  last: 'tg_quiz_last',
  lastError: 'tg_quiz_last_error',
  lastPost: 'tg_quiz_last_post',
  used: 'tg_quiz_used',
};

const tashkentDay = (d = new Date()) =>
  new Date(d.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);

const cut = (s: string, max: number) =>
  s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';

export interface ChannelQuizPick {
  articleId: number;
  title: string;
  slug: string;
  question: QuizQuestion;
}

/**
 * Telegram kanalda har kuni "Kun savoli": chop etilgan maqolalar testidan
 * bitta savol Telegram'ning o'z quiz-so'rovnomasi bo'lib chiqadi, tagida
 * "Javobini maqolada o'qing" tugmasi. Testlar allaqachon tuzilgan
 * (article_quizzes) — AI'ga qo'shimcha so'rov yo'q.
 *
 * Kuniga bir marta (Toshkent vaqti, sozlanadigan soatda), bir maqola qayta
 * ishlatilmaydi (hammasi tugasa — boshidan).
 */
@Injectable()
export class ChannelQuizService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelQuizService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly telegram: TelegramService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  onModuleInit() {
    this.schedule(BOOT_DELAY_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  // ---------- app_settings ----------

  private async get(key: string): Promise<string | null> {
    try {
      const [row] = await this.sequelize.query<{ value: string }>(
        'SELECT value FROM app_settings WHERE key = :key',
        { replacements: { key }, type: QueryTypes.SELECT },
      );
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private async set(key: string, value: string) {
    await this.sequelize.query(
      `INSERT INTO app_settings (key, value, "updatedAt") VALUES (:key, :value, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      { replacements: { key, value } },
    );
  }

  private async getUsed(): Promise<number[]> {
    try {
      const v = JSON.parse((await this.get(K.used)) ?? '[]');
      return Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : [];
    } catch {
      return [];
    }
  }

  private async hour(): Promise<number> {
    // Number(null) = 0 — sozlanmagan bo'lsa yarim tunda ketib qolmasin
    const v = await this.get(K.hour);
    const n = v === null || v.trim() === '' ? NaN : Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : DEFAULT_HOUR;
  }

  // ---------- Savol tanlash ----------

  /** Telegram cheklovlariga sig'adigan savol (bo'lmasa null) */
  static fit(q: QuizQuestion): QuizQuestion | null {
    if (!q?.q || !Array.isArray(q.options) || q.options.length < 2) return null;
    if (PREFIX.length + q.q.length > Q_MAX) return null;
    if (q.options.some((o) => !o || o.length > OPT_MAX)) return null;
    if (!Number.isInteger(q.answer) || !q.options[q.answer]) return null;
    return q;
  }

  /**
   * Hali kanalda bo'lmagan maqolalardan tasodifiy biri va uning sig'adigan
   * savoli. Hammasi ishlatilgan bo'lsa — ro'yxat tozalanadi, boshidan.
   */
  async pick(rand = Math.random): Promise<ChannelQuizPick | null> {
    const rows = await this.sequelize.query<{
      id: number;
      title: string;
      slug: string;
      questions: QuizQuestion[] | string;
    }>(
      `SELECT a.id, a.title, a.slug, q.questions
       FROM article_quizzes q JOIN articles a ON a.id = q."articleId"
       WHERE a.status = 'published'
       ORDER BY a."createdAt" DESC`,
      { type: QueryTypes.SELECT },
    );
    const parsed = rows
      .map((r) => {
        let qs: unknown = r.questions;
        if (typeof qs === 'string') {
          try {
            qs = JSON.parse(qs);
          } catch {
            qs = [];
          }
        }
        const fits = (Array.isArray(qs) ? qs : [])
          .map((q) => ChannelQuizService.fit(q as QuizQuestion))
          .filter((q): q is QuizQuestion => Boolean(q));
        return { ...r, fits };
      })
      .filter((r) => r.fits.length);
    if (!parsed.length) return null;

    const used = new Set(await this.getUsed());
    let pool = parsed.filter((r) => !used.has(r.id));
    if (!pool.length) {
      await this.set(K.used, '[]');
      pool = parsed;
    }
    // Yangi maqolalarga biroz ustunlik: yarmida eng yangi 10 tadan tanlanadi
    const recent = pool.slice(0, 10);
    const from = rand() < 0.5 ? recent : pool;
    const r = from[Math.floor(rand() * from.length)];
    return {
      articleId: r.id,
      title: r.title,
      slug: r.slug,
      question: r.fits[Math.floor(rand() * r.fits.length)],
    };
  }

  // ---------- Yuborish ----------

  /** Bitta savolni kanalga yuboradi; maqola "ishlatilgan"ga yoziladi */
  async post(): Promise<ChannelQuizPick> {
    if (!this.telegram.configured)
      throw new Error(
        'Telegram kanal sozlanmagan (TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID)',
      );
    const p = await this.pick();
    if (!p)
      throw new Error(
        "Kanalga mos test topilmadi — chop etilgan maqolalarda hali test yo'q",
      );
    const q = p.question;
    await this.telegram.call('sendPoll', {
      chat_id: this.telegram.channelId,
      question: PREFIX + q.q,
      options: q.options.map((text) => ({ text })),
      type: 'quiz',
      is_anonymous: true,
      correct_option_id: q.answer,
      ...(q.explain ? { explanation: cut(q.explain, EXPLAIN_MAX) } : {}),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📖 Javobini maqolada o'qing",
              url: this.telegram.readUrl(p.slug, 'quiz'),
            },
          ],
        ],
      },
    });
    const used = await this.getUsed();
    used.push(p.articleId);
    await this.set(K.used, JSON.stringify(used.slice(-3000)));
    await this.set(
      K.lastPost,
      JSON.stringify({
        at: new Date().toISOString(),
        title: p.title,
        slug: p.slug,
        question: q.q,
      }),
    );
    await this.set(K.lastError, '');
    this.logger.log(`Kun savoli yuborildi: ${p.title}`);
    return p;
  }

  // ---------- Kunlik jadval ----------

  private schedule(delay?: number) {
    if (this.timer) clearTimeout(this.timer);
    const run = async () => {
      try {
        await this.runIfDue();
      } catch (err: any) {
        this.logger.warn(`Kun savoli: ${err?.message}`);
      }
      this.schedule();
    };
    void (async () => {
      let wait = delay;
      if (wait === undefined) {
        const now = Date.now();
        const local = new Date(now + TASHKENT_OFFSET_MS);
        local.setUTCHours(await this.hour(), 0, 30, 0);
        let next = local.getTime() - TASHKENT_OFFSET_MS;
        if (next <= now) next += 24 * 60 * 60 * 1000;
        wait = Math.min(next - now, MAX_WAIT_MS);
      }
      this.timer = setTimeout(() => void run(), wait);
      this.timer.unref();
    })();
  }

  /** Bugun hali yuborilmagan va belgilangan soatdan o'tgan bo'lsa — yuboradi */
  async runIfDue(now = new Date()): Promise<'sent' | 'skipped' | 'failed'> {
    if (this.running || !this.telegram.configured) return 'skipped';
    if ((await this.get(K.enabled)) === 'off') return 'skipped';
    const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
    if (local.getUTCHours() < (await this.hour())) return 'skipped';
    const today = tashkentDay(now);
    if ((await this.get(K.last)) === today) return 'skipped';

    this.running = true;
    try {
      // Avval belgilanadi — xato bo'lsa ham kuniga bir marta (kanal spam bo'lmasin)
      await this.set(K.last, today);
      await this.post();
      return 'sent';
    } catch (err: any) {
      await this.set(K.lastError, String(err?.message ?? err).slice(0, 300));
      this.logger.warn(`Kun savoli yuborilmadi: ${err?.message}`);
      return 'failed';
    } finally {
      this.running = false;
    }
  }

  // ---------- Admin ----------

  async status() {
    const [enabled, last, lastError, lastPost, used, total] = await Promise.all(
      [
        this.get(K.enabled),
        this.get(K.last),
        this.get(K.lastError),
        this.get(K.lastPost),
        this.getUsed(),
        this.sequelize
          .query<{ n: string }>(
            `SELECT COUNT(*) AS n FROM article_quizzes q JOIN articles a ON a.id = q."articleId"
             WHERE a.status = 'published'`,
            { type: QueryTypes.SELECT },
          )
          .then((r) => Number(r[0]?.n ?? 0))
          .catch(() => 0),
      ],
    );
    let post: unknown = null;
    try {
      post = lastPost ? JSON.parse(lastPost) : null;
    } catch {
      post = null;
    }
    return {
      configured: this.telegram.configured,
      enabled: enabled !== 'off',
      hour: await this.hour(),
      lastDay: last,
      lastError: lastError || null,
      lastPost: post,
      withQuiz: total,
      used: used.length,
    };
  }

  async update(body: { enabled?: unknown; hour?: unknown }) {
    if (body.enabled !== undefined)
      await this.set(K.enabled, body.enabled ? 'on' : 'off');
    if (body.hour !== undefined) {
      const n = Math.round(Number(body.hour));
      if (Number.isInteger(n) && n >= 0 && n <= 23)
        await this.set(K.hour, String(n));
    }
    this.schedule(5000);
    return this.status();
  }

  /** Admin "Hozir yuborish": bugungi savol hisoblanadi (kechqurun takrorlanmaydi) */
  async sendNow() {
    const p = await this.post();
    await this.set(K.last, tashkentDay());
    return { title: p.title, question: p.question.q };
  }
}
