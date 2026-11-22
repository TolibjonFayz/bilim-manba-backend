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
import { chunkText, joinPcm, speechText, toMp3 } from './audio-tools';
import { createTts, TtsError } from './gemini-tts';

const HOUR_MS = 60 * 60 * 1000;
const TASHKENT_OFFSET_MS = 5 * HOUR_MS;
const BOOT_DELAY_MS = 4 * 60 * 1000;
const TICK_MS = 20 * 60 * 1000;
/** Bepul tarif daqiqasiga bir necha so'rovga ruxsat beradi — bo'laklar orasida tanaffus */
const CHUNK_GAP_MS = 21_000;
/** Limit (429) tugasa — shuncha kutiladi */
const PAUSE_MS = 6 * HOUR_MS;
const DEFAULT_DAILY = 5;
const CHUNK_CHARS = 3000;

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
};

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
  ) {}

  onModuleInit() {
    this.timer = setTimeout(() => void this.loop(), BOOT_DELAY_MS);
    this.timer.unref();
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
      `INSERT INTO article_audio ("articleId", url, seconds, voice, chars, model, "createdAt")
       VALUES (:id, :url, :seconds, :voice, :chars, :model, now())
       ON CONFLICT ("articleId") DO UPDATE SET url = EXCLUDED.url, seconds = EXCLUDED.seconds,
         voice = EXCLUDED.voice, chars = EXCLUDED.chars, model = EXCLUDED.model, "createdAt" = now()`,
      {
        replacements: {
          id: a.id,
          url,
          seconds,
          voice,
          chars: text.length,
          model,
        },
      },
    );
    this.logger.log(`Audio tayyor: ${a.title} (${seconds} s, ${voice})`);
    return { url, seconds };
  }

  /** Navbatdagi maqola: avval oxirgi 3 kunda chop etilganlar, keyin eng ko'p o'qilganlar */
  async nextArticleId(): Promise<number | null> {
    const [row] = await this.sequelize.query<{ id: number }>(
      `SELECT a.id FROM articles a
       LEFT JOIN article_audio au ON au."articleId" = a.id
       WHERE a.status = 'published' AND au."articleId" IS NULL
       ORDER BY (COALESCE(a."scheduledAt", a."createdAt") > now() - interval '3 days') DESC,
                a."viewCount" DESC, a.id DESC
       LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    return row?.id ?? null;
  }

  /** Davriy ish: yoqilgan, pauza yo'q va kunlik limit tugamagan bo'lsa — bitta maqola */
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
    if (done >= this.dailyMax) return 'skipped';
    const id = await this.nextArticleId();
    if (!id) return 'idle';

    this.running = true;
    try {
      await this.generateFor(id);
      await this.set(K.day, `${today}:${done + 1}`);
      await this.set(K.lastError, null);
      return 'done';
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 300);
      await this.set(
        K.lastError,
        JSON.stringify({ at: now.toISOString(), articleId: id, message: msg }),
      );
      if (err instanceof TtsError && err.rateLimited) {
        await this.set(
          K.pauseUntil,
          new Date(now.getTime() + PAUSE_MS).toISOString(),
        );
      } else {
        // Shu maqola yana-yana yiqilmasin: bugungi hisobga qo'shiladi
        await this.set(K.day, `${today}:${done + 1}`);
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

  async settings(body: { enabled?: boolean; voice?: string }) {
    if (body.voice !== undefined) {
      if (!VOICES.some((v) => v.id === body.voice))
        throw new BadRequestException("Noma'lum ovoz");
      await this.set(K.voice, body.voice);
    }
    if (body.enabled !== undefined) {
      await this.set(K.enabled, body.enabled ? 'on' : 'off');
      if (body.enabled) {
        await this.set(K.pauseUntil, null);
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
    const [d, c] = String(day ?? '').split(':');
    return {
      configured: Boolean(this.key),
      enabled: enabled === 'on',
      voice,
      voices: VOICES,
      dailyMax: this.dailyMax,
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
