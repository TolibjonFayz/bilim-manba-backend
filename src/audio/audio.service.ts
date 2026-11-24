import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import { TelegramService } from '../publishing/telegram.service';
import { chunkText, joinPcm, speechText, toMp3 } from './audio-tools';
import { createTts, TtsError } from './gemini-tts';

const HOUR_MS = 60 * 60 * 1000;
const TASHKENT_OFFSET_MS = 5 * HOUR_MS;
const BOOT_DELAY_MS = 4 * 60 * 1000;
const TICK_MS = 20 * 60 * 1000;
/** Bepul tarif daqiqasiga bir necha so'rovga ruxsat beradi — bo'laklar orasida tanaffus */
const CHUNK_GAP_MS = 21_000;
/** Limit (429) tugasa — shuncha kutiladi */
const PAUSE_MS = HOUR_MS;
/** Bitta maqola shuncha marta yiqilsa — navbatdan o'tkazib yuboriladi */
const MAX_FAILS = 3;
const DEFAULT_DAILY = 5;
// ~8 daqiqalik nutq (Gemini bitta javobda ~11 daqiqagacha beradi): kamroq so'rov —
// bepul kunlik limit ko'proq maqolaga yetadi
const CHUNK_CHARS = 6500;

/** Admin tanlashi mumkin bo'lgan ovozlar (Gemini prebuilt) */
export const VOICES = [
  { id: 'Charon', label: 'Charon — erkak, xotirjam, tushuntiruvchi' },
  { id: 'Kore', label: 'Kore — ayol, aniq, ishonchli' },
  { id: 'Orus', label: "Orus — erkak, qat'iy" },
  { id: 'Sulafat', label: 'Sulafat — ayol, iliq' },
  { id: 'Puck', label: 'Puck — erkak, quvnoq' },
  { id: 'Aoede', label: 'Aoede — ayol, yengil' },
];
const DEFAULT_VOICE = 'Charon';

export const SAMPLE_TEXT =
  "Assalomu alaykum! Bu — Bilim Manba. Bugun sizga koinotning eng sirli hodisalaridan biri, qora tuynuklar haqida so'zlab beramiz. Ular qanday paydo bo'ladi va nega hatto yorug'lik ham ulardan qochib qutula olmaydi?";

const K = {
  enabled: 'audio_enabled',
  voice: 'audio_voice',
  pauseUntil: 'audio_pause_until',
  lastError: 'audio_last_error',
  day: 'audio_day', // "2026-11-22:3" — bugun nechta maqola ovozlashtirildi
  telegram: 'audio_telegram', // 'off' — kanalga audio yuborilmaydi
  fails: 'audio_fails', // {"139": 2} — maqola necha marta yiqilgani
};

/**
 * Gemini kunlik limiti Tinch okeani vaqti bilan yarim tunda yangilanadi
 * (≈ 08:00 UTC = 13:00 Toshkent). Kunlik limit tugasa — shu vaqtgacha kutiladi.
 */
/**
 * Limit tugaganda qachon qayta urinish: Google xatoda aniq vaqtni aytadi
 * ("Please retry in 16h20m53s" / "retry in 42.5s") — shundan 2 daqiqa
 * keyin. Aytilmagan bo'lsa: kunlik limit → yangilanish vaqti, aks holda 1 soat.
 */
export function resumeAfterLimit(msg: string, now: Date) {
  const m = /retry in\s*(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i.exec(
    msg,
  );
  const ms = m
    ? ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) *
      1000
    : 0;
  if (ms > 0) return new Date(now.getTime() + ms + 2 * 60 * 1000);
  return /day|daily|per ?day/i.test(msg)
    ? nextQuotaReset(now)
    : new Date(now.getTime() + PAUSE_MS);
}

export function nextQuotaReset(now: Date) {
  const t = new Date(now);
  t.setUTCHours(8, 5, 0, 0);
  if (t <= now) t.setTime(t.getTime() + 24 * HOUR_MS);
  return t;
}

/** Faqat yangi maqolalar audiosi kanalga chiqadi (eskilari kanalni to'ldirib yubormasin) */
const TG_FRESH_DAYS = 3;
const FEED_CACHE_MS = 10 * 60 * 1000;

export interface AudioFeedItem {
  title: string;
  slug: string;
  excerpt: string | null;
  coverImage: string | null;
  category: string | null;
  url: string;
  seconds: number;
  bytes: number | null;
  published: string;
}

const tashkentDay = (d = new Date()) =>
  new Date(d.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Audio maqolalar: maqola matni Gemini TTS bilan o'zbekcha ovozga aylanadi,
 * MP3 R2'ga yuklanadi, maqola sahifasida "🎧 Tinglash" pleyeri chiqadi.
 *  - Admin yoqmaguncha ishlamaydi (avval ovoz namunasini tinglab tanlaydi).
 *  - Yangi chop etilgan maqolalar birinchi, keyin eng ko'p o'qilganlar.
 *  - Kuniga ko'pi bilan N ta maqola (AUDIO_DAILY_MAX, default 5) — bepul
 *    limit tugasa (429) 6 soat kutadi.
 *  - Maqola matni o'zgarsa — eski audio o'chiriladi, qayta yaratiladi.
 */
@Injectable()
export class AudioService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AudioService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Testlar uchun: soxta fetch va tanaffus */
  fetchOverride?: typeof fetch;
  gapMs = CHUNK_GAP_MS;

  constructor(
    private readonly config: ConfigService,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly cloudflare: CloudflareService,
    private readonly telegram: TelegramService,
  ) {}

  private feedCache?: { at: number; items: AudioFeedItem[] };

  onModuleInit() {
    this.timer = setTimeout(() => void this.loop(), BOOT_DELAY_MS);
    this.timer.unref();
    void this.resetFailsOnce();
  }

  /**
   * 2026-11-25: limit (429) xatolari ba'zan "maqola xatosi" deb hisoblangan
   * edi — yangi maqolalar navbatdan chiqib ketmasin, hisob bir marta tozalanadi.
   */
  private async resetFailsOnce() {
    try {
      if (await this.get('once_audio_fails_reset_v1')) return;
      await this.set(K.fails, null);
      await this.set('once_audio_fails_reset_v1', new Date().toISOString());
    } catch {
      /* jadval hali yo'q bo'lsa — keyingi ishga tushishda */
    }
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  private async loop() {
    try {
      await this.tick();
    } catch (err: any) {
      this.logger.warn(`Audio: ${err?.message}`);
    }
    this.timer = setTimeout(() => void this.loop(), TICK_MS);
    this.timer.unref();
  }

  // ---------- sozlamalar ----------

  private async get(key: string) {
    const rows = await this.sequelize.query<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = :key',
      { replacements: { key }, type: QueryTypes.SELECT },
    );
    return rows[0]?.value ?? null;
  }

  private async set(key: string, value: string | null) {
    if (value === null) {
      await this.sequelize.query('DELETE FROM app_settings WHERE key = :key', {
        replacements: { key },
      });
      return;
    }
    await this.sequelize.query(
      `INSERT INTO app_settings (key, value, "updatedAt") VALUES (:key, :value, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      { replacements: { key, value } },
    );
  }

  private get key() {
    return (this.config.get<string>('GEMINI_API_KEY') ?? '').trim();
  }

  private get dailyMax() {
    const n = Number(this.config.get<string>('AUDIO_DAILY_MAX'));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY;
  }

  private tts() {
    if (!this.key) throw new BadRequestException('GEMINI_API_KEY sozlanmagan');
    const models = (this.config.get<string>('GEMINI_TTS_MODELS') ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    return createTts({ key: this.key, models, fetch: this.fetchOverride });
  }

  async voice() {
    const v = await this.get(K.voice);
    return VOICES.some((x) => x.id === v) ? (v as string) : DEFAULT_VOICE;
  }

  // ---------- ommaviy ----------

  /** Maqola sahifasi uchun: { url, seconds } yoki null */
  async forArticle(articleId: number) {
    try {
      const rows = await this.sequelize.query<{ url: string; seconds: number }>(
        'SELECT url, seconds FROM article_audio WHERE "articleId" = :id',
        { replacements: { id: articleId }, type: QueryTypes.SELECT },
      );
      return rows[0]
        ? { url: rows[0].url, seconds: Number(rows[0].seconds) }
        : null;
    } catch {
      return null;
    }
  }

  /** Maqola matni o'zgardi — eski ovoz endi to'g'ri emas */
  async invalidate(articleId: number) {
    await this.sequelize
      .query('DELETE FROM article_audio WHERE "articleId" = :id', {
        replacements: { id: articleId },
      })
      .catch(() => {});
  }

  // ---------- yaratish ----------

  private async fetchContent(url?: string | null) {
    if (!url) return '';
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const j: any = await res.json();
    return String(j?.message ?? '');
  }

  /** Matn → MP3 (bo'laklab), qaytaradi: MP3 va davomiyligi */
  async synthesize(text: string, voice: string) {
    const tts = this.tts();
    const parts: Int16Array[] = [];
    let rate = 24000;
    const chunks = chunkText(text, CHUNK_CHARS);
    for (let i = 0; i < chunks.length; i++) {
      if (i && this.gapMs) await sleep(this.gapMs);
      const r = await tts.speak(chunks[i], voice);
      rate = r.rate;
      parts.push(r.pcm);
    }
    const pcm = joinPcm(parts, rate);
    return {
      mp3: await toMp3(pcm, rate),
      seconds: Math.round(pcm.length / rate),
      chunks: chunks.length,
      model: tts.route?.model ?? '',
    };
  }

  /** Bitta maqolani ovozlashtiradi va saqlaydi */
  async generateFor(articleId: number) {
    const [a] = await this.sequelize.query<{
      id: number;
      title: string;
      content: string;
    }>(
      `SELECT id, title, content FROM articles WHERE id = :id AND status = 'published'`,
      { replacements: { id: articleId }, type: QueryTypes.SELECT },
    );
    if (!a) throw new BadRequestException('Chop etilgan maqola topilmadi');
    const text = speechText(a.title, await this.fetchContent(a.content));
    if (text.length < 300)
      throw new BadRequestException('Maqola matni juda qisqa');
    const voice = await this.voice();
    const { mp3, seconds, model } = await this.synthesize(text, voice);
    const url = await this.cloudflare.uploadAudio(
      mp3,
      `audio/${a.id}-${Date.now().toString(36)}.mp3`,
    );
    await this.sequelize.query(
      `INSERT INTO article_audio ("articleId", url, seconds, voice, chars, model, bytes, "createdAt")
       VALUES (:id, :url, :seconds, :voice, :chars, :model, :bytes, now())
       ON CONFLICT ("articleId") DO UPDATE SET url = EXCLUDED.url, seconds = EXCLUDED.seconds,
         voice = EXCLUDED.voice, chars = EXCLUDED.chars, model = EXCLUDED.model,
         bytes = EXCLUDED.bytes, "createdAt" = now()`,
      {
        replacements: {
          id: a.id,
          url,
          seconds,
          voice,
          chars: text.length,
          model,
          bytes: mp3.length,
        },
      },
    );
    this.feedCache = undefined;
    this.logger.log(`Audio tayyor: ${a.title} (${seconds} s, ${voice})`);
    await this.postToTelegram(a.id).catch((err) =>
      this.logger.warn(`Audio kanalga yuborilmadi (${a.id}): ${err?.message}`),
    );
    return { url, seconds };
  }

  /**
   * Yangi maqola (oxirgi 3 kun) audiosi kanalga — bir marta. Eski maqolalar
   * audiosi kanalga chiqmaydi (kunda 5 tadan eski post kanalni to'ldirmasin).
   */
  async postToTelegram(articleId: number, now = new Date()) {
    if (!this.telegram.configured) return false;
    if ((await this.get(K.telegram)) === 'off') return false;
    const [r] = await this.sequelize.query<{
      title: string;
      slug: string;
      url: string;
      seconds: number;
    }>(
      `SELECT a.title, a.slug, au.url, au.seconds FROM article_audio au
       JOIN articles a ON a.id = au."articleId"
       WHERE au."articleId" = :id AND au."tgPostedAt" IS NULL AND a.status = 'published'
         AND COALESCE(a."scheduledAt", a."createdAt") > :since`,
      {
        replacements: {
          id: articleId,
          since: new Date(now.getTime() - TG_FRESH_DAYS * 24 * HOUR_MS),
        },
        type: QueryTypes.SELECT,
      },
    );
    if (!r) return false;
    await this.telegram.sendArticleAudio({ ...r, seconds: Number(r.seconds) });
    await this.sequelize.query(
      'UPDATE article_audio SET "tgPostedAt" = now() WHERE "articleId" = :id',
      { replacements: { id: articleId } },
    );
    return true;
  }

  /**
   * Podkast lentasi va /audio sahifasi uchun: audiosi bor maqolalar (eng
   * yangisi birinchi). Hajmi noma'lum eski yozuvlar uchun R2'dan so'raladi.
   */
  async feed(): Promise<AudioFeedItem[]> {
    const c = this.feedCache;
    if (c && Date.now() - c.at < FEED_CACHE_MS) return c.items;
    const rows = await this.sequelize.query<
      AudioFeedItem & { articleId: number }
    >(
      `SELECT a.id AS "articleId", a.title, a.slug, a.excerpt, a."coverImage", c.name AS category,
              au.url, au.seconds, au.bytes,
              COALESCE(a."scheduledAt", a."createdAt") AS published
       FROM article_audio au
       JOIN articles a ON a.id = au."articleId"
       LEFT JOIN categories c ON c.id = a."categoryId"
       WHERE a.status = 'published'
       ORDER BY COALESCE(a."scheduledAt", a."createdAt") DESC
       LIMIT 300`,
      { type: QueryTypes.SELECT },
    );
    for (const r of rows.filter((x) => !x.bytes).slice(0, 20)) {
      try {
        const res = await (this.fetchOverride ?? fetch)(r.url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(8000),
        });
        const n = Number(res.headers.get('content-length'));
        if (n > 0) {
          r.bytes = n;
          await this.sequelize.query(
            'UPDATE article_audio SET bytes = :n WHERE "articleId" = :id',
            { replacements: { n, id: r.articleId } },
          );
        }
      } catch {
        /* keyingi safar */
      }
    }
    const items = rows.map(({ articleId: _id, ...r }) => ({
      ...r,
      seconds: Number(r.seconds),
      bytes: r.bytes ? Number(r.bytes) : null,
      published: new Date(r.published).toISOString(),
    }));
    this.feedCache = { at: Date.now(), items };
    return items;
  }

  private async fails(): Promise<Record<string, number>> {
    try {
      return JSON.parse((await this.get(K.fails)) ?? '{}') ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Navbatdagi maqola: avval yangilari (oxirgi 3 kun, eng yangisi birinchi),
   * keyin eng ko'p o'qilgan eskilari. 3 marta yiqilganlar o'tkazib yuboriladi.
   */
  async nextArticle(): Promise<{ id: number; fresh: boolean } | null> {
    const skip = Object.entries(await this.fails())
      .filter(([, n]) => n >= MAX_FAILS)
      .map(([id]) => Number(id));
    const [row] = await this.sequelize.query<{ id: number; fresh: boolean }>(
      `SELECT a.id,
              COALESCE(a."scheduledAt", a."createdAt") > now() - interval '${TG_FRESH_DAYS} days' AS fresh
       FROM articles a
       LEFT JOIN article_audio au ON au."articleId" = a.id
       WHERE a.status = 'published' AND au."articleId" IS NULL
         ${skip.length ? 'AND a.id NOT IN (:skip)' : ''}
       ORDER BY fresh DESC,
                CASE WHEN COALESCE(a."scheduledAt", a."createdAt") > now() - interval '${TG_FRESH_DAYS} days'
                     THEN COALESCE(a."scheduledAt", a."createdAt") END DESC NULLS LAST,
                a."viewCount" DESC, a.id DESC
       LIMIT 1`,
      { replacements: { skip }, type: QueryTypes.SELECT },
    );
    return row ? { id: Number(row.id), fresh: Boolean(row.fresh) } : null;
  }

  /** Eski nom (testlar) */
  async nextArticleId() {
    return (await this.nextArticle())?.id ?? null;
  }

  /**
   * Davriy ish (har 20 daqiqada): bitta maqola. Yangi maqolalar kunlik
   * limitga kirmaydi — chop etilishi bilan ovozlashtiriladi; kunlik limit
   * (AUDIO_DAILY_MAX) faqat eski maqolalar uchun. Gemini limiti tugasa —
   * kunlik bo'lsa yangilanish vaqtigacha, aks holda 1 soat kutadi.
   */
  async tick(
    now = new Date(),
  ): Promise<'done' | 'skipped' | 'failed' | 'idle'> {
    if (this.running || !this.key) return 'skipped';
    if ((await this.get(K.enabled)) !== 'on') return 'skipped';
    const pause = await this.get(K.pauseUntil);
    if (pause && new Date(pause) > now) return 'skipped';
    const today = tashkentDay(now);
    const [day, count] = String((await this.get(K.day)) ?? '').split(':');
    const done = day === today ? Number(count) || 0 : 0;
    const next = await this.nextArticle();
    if (!next) return 'idle';
    if (!next.fresh && done >= this.dailyMax) return 'skipped';
    const id = next.id;

    this.running = true;
    try {
      await this.generateFor(id);
      if (!next.fresh) await this.set(K.day, `${today}:${done + 1}`);
      const fails = await this.fails();
      if (fails[id]) {
        delete fails[id];
        await this.set(K.fails, JSON.stringify(fails));
      }
      await this.set(K.lastError, null);
      await this.set(K.pauseUntil, null);
      return 'done';
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 300);
      await this.set(
        K.lastError,
        JSON.stringify({ at: now.toISOString(), articleId: id, message: msg }),
      );
      if (err instanceof TtsError && err.rateLimited) {
        const until = resumeAfterLimit(msg, now);
        await this.set(K.pauseUntil, until.toISOString());
      } else {
        // Shu maqola qayta-qayta yiqilmasin (3 martadan keyin o'tkazib yuboriladi);
        // kunlik limitni yemaydi
        const fails = await this.fails();
        fails[id] = (fails[id] ?? 0) + 1;
        await this.set(K.fails, JSON.stringify(fails));
      }
      this.logger.warn(`Audio yaratilmadi (${id}): ${msg}`);
      return 'failed';
    } finally {
      this.running = false;
    }
  }

  // ---------- admin ----------

  /** Ovoz namunasi (admin tinglab tanlaydi) */
  async sample(voice: string) {
    if (!VOICES.some((v) => v.id === voice))
      throw new BadRequestException("Noma'lum ovoz");
    try {
      const { mp3, seconds, model } = await this.synthesize(SAMPLE_TEXT, voice);
      return {
        voice,
        seconds,
        model,
        audio: `data:audio/mpeg;base64,${mp3.toString('base64')}`,
      };
    } catch (err: any) {
      throw new BadRequestException(
        `Ovoz yaratilmadi: ${String(err?.message ?? err).slice(0, 300)}`,
      );
    }
  }

  async settings(body: {
    enabled?: boolean;
    voice?: string;
    telegram?: boolean;
  }) {
    if (body.telegram !== undefined) {
      await this.set(K.telegram, body.telegram ? 'on' : 'off');
    }
    if (body.voice !== undefined) {
      if (!VOICES.some((v) => v.id === body.voice))
        throw new BadRequestException("Noma'lum ovoz");
      await this.set(K.voice, body.voice);
    }
    if (body.enabled !== undefined) {
      await this.set(K.enabled, body.enabled ? 'on' : 'off');
      if (body.enabled) {
        await this.set(K.pauseUntil, null);
        await this.set(K.fails, null);
        // Darhol bitta maqola (keyin har 20 daqiqada)
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.loop(), 3000);
        this.timer.unref();
      }
    }
    return this.status();
  }

  async status() {
    const [enabled, voice, pause, lastError, day, counts] = await Promise.all([
      this.get(K.enabled),
      this.voice(),
      this.get(K.pauseUntil),
      this.get(K.lastError),
      this.get(K.day),
      this.sequelize.query<{ done: string; total: string; seconds: string }>(
        `SELECT (SELECT COUNT(*) FROM article_audio au JOIN articles a ON a.id = au."articleId" WHERE a.status = 'published') AS done,
                (SELECT COUNT(*) FROM articles WHERE status = 'published') AS total,
                (SELECT COALESCE(SUM(seconds), 0) FROM article_audio) AS seconds`,
        { type: QueryTypes.SELECT },
      ),
    ]);
    const telegramSetting = await this.get(K.telegram);
    const failMap = await this.fails();
    const [fresh] = await this.sequelize.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM articles a LEFT JOIN article_audio au ON au."articleId" = a.id
       WHERE a.status = 'published' AND au."articleId" IS NULL
         AND COALESCE(a."scheduledAt", a."createdAt") > now() - interval '${TG_FRESH_DAYS} days'`,
      { type: QueryTypes.SELECT },
    );
    const [d, c] = String(day ?? '').split(':');
    return {
      configured: Boolean(this.key),
      enabled: enabled === 'on',
      voice,
      voices: VOICES,
      dailyMax: this.dailyMax,
      telegram: telegramSetting !== 'off',
      freshPending: Number(fresh?.n ?? 0),
      skipped: Object.values(failMap).filter((n) => n >= MAX_FAILS).length,
      telegramConfigured: this.telegram.configured,
      today: d === tashkentDay() ? Number(c) || 0 : 0,
      pausedUntil: pause && new Date(pause) > new Date() ? pause : null,
      lastError: lastError ? JSON.parse(lastError) : null,
      done: Number(counts[0]?.done ?? 0),
      total: Number(counts[0]?.total ?? 0),
      minutes: Math.round(Number(counts[0]?.seconds ?? 0) / 60),
      running: this.running,
    };
  }
}
