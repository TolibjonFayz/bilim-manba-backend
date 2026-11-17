import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { InstagramMedia, InstagramService } from './instagram.service';
import { TelegramService } from './telegram.service';

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_DAYS = 3;
// Kunduzi — kanal "Kun savoli" (19:00) bilan to'qnashmasin
const DEFAULT_HOUR = 12;
const BOOT_DELAY_MS = 3 * 60 * 1000;
const CHECK_EVERY_MS = HOUR_MS;
// Bir post 3 marta yuborilmasa — tashlab o'tiladi (navbat tiqilib qolmasin)
const MAX_FAILS = 3;
const CAPTION_MAX = 1024;

const K = {
  enabled: 'ig_tg_enabled',
  days: 'ig_tg_days',
  hour: 'ig_tg_hour',
  last: 'ig_tg_last',
  sent: 'ig_tg_sent',
  fails: 'ig_tg_fails',
  lastPost: 'ig_tg_last_post',
  lastError: 'ig_tg_last_error',
};

const cut = (s: string, max: number) =>
  s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';

/**
 * Instagram'dagi postlar Telegram kanalga ham: har N kunda (standart 3)
 * bittadan, eng eskisidan boshlab. Rasm — rasm, video — video, karusel —
 * albom bo'lib chiqadi; matni Instagram'dagi tavsif, tagida Instagram'dagi
 * postga havola. Qaysi postlar yuborilgani app_settings'da saqlanadi —
 * bitta post ikki marta chiqmaydi. Yangi Instagram postlari navbatga
 * o'zi qo'shiladi.
 */
@Injectable()
export class IgRepostService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IgRepostService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly instagram: InstagramService,
    private readonly telegram: TelegramService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  onModuleInit() {
    this.timer = setTimeout(() => this.loop(), BOOT_DELAY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  private loop() {
    void this.runIfDue()
      .catch((err) => this.logger.error(`Instagram→Telegram: ${err?.message}`))
      .finally(() => {
        this.timer = setTimeout(() => this.loop(), CHECK_EVERY_MS);
        this.timer.unref?.();
      });
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

  private async json<T>(key: string, fallback: T): Promise<T> {
    try {
      const v = await this.get(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private async settings() {
    const enabled = (await this.get(K.enabled)) !== '0'; // standart: yoqilgan
    const d = Number(await this.get(K.days));
    const h = await this.get(K.hour);
    const hn = h === null || h.trim() === '' ? NaN : Number(h);
    return {
      enabled,
      days: Number.isInteger(d) && d >= 1 && d <= 30 ? d : DEFAULT_DAYS,
      hour: Number.isInteger(hn) && hn >= 0 && hn <= 23 ? hn : DEFAULT_HOUR,
    };
  }

  // ---------- navbat ----------

  /** Hali kanalga chiqmagan postlar, eng eskisi birinchi */
  async queue(): Promise<InstagramMedia[]> {
    const [media, sent, fails] = await Promise.all([
      this.instagram.listMedia(),
      this.json<string[]>(K.sent, []),
      this.json<Record<string, number>>(K.fails, {}),
    ]);
    const done = new Set(sent);
    return media
      .filter((m) => !done.has(m.id) && (fails[m.id] ?? 0) < MAX_FAILS)
      .filter((m) => m.media_url || m.children?.length)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }

  /** Kanalga chiqadigan matn: Instagram tavsifi + havola */
  static caption(m: InstagramMedia): string {
    const link = m.permalink ? `\n\n📷 Instagram'da: ${m.permalink}` : '';
    const text = String(m.caption ?? '').trim();
    return cut(text, CAPTION_MAX - link.length) + link;
  }

  /** Bitta Instagram postini kanalga yuboradi */
  async sendMedia(m: InstagramMedia) {
    const chat_id = this.telegram.channelId;
    const caption = IgRepostService.caption(m);
    if (m.media_type === 'CAROUSEL_ALBUM') {
      const items = (m.children ?? [])
        .filter((c) => c.media_url)
        .slice(0, 10)
        .map((c, i) => ({
          type: c.media_type === 'VIDEO' ? 'video' : 'photo',
          media: c.media_url,
          ...(i === 0 ? { caption } : {}),
        }));
      if (!items.length) throw new Error("Albomda rasm yo'q");
      if (items.length === 1) {
        return this.telegram.call(
          items[0].type === 'video' ? 'sendVideo' : 'sendPhoto',
          { chat_id, [items[0].type]: items[0].media, caption },
        );
      }
      return this.telegram.call('sendMediaGroup', { chat_id, media: items });
    }
    if (m.media_type === 'VIDEO') {
      return this.telegram.call('sendVideo', {
        chat_id,
        video: m.media_url,
        caption,
        supports_streaming: true,
      });
    }
    return this.telegram.call('sendPhoto', {
      chat_id,
      photo: m.media_url,
      caption,
    });
  }

  /** Navbatdagi postni yuboradi (admin "hozir yuborish" ham shu) */
  async postNext(
    now = new Date(),
  ): Promise<{ id: string; caption: string } | null> {
    if (!this.telegram.configured) {
      throw new Error('Telegram kanal sozlanmagan');
    }
    if (!this.instagram.configured) {
      throw new Error('Instagram ulanmagan (INSTAGRAM_ACCESS_TOKEN)');
    }
    const next = (await this.queue())[0];
    if (!next) return null;
    try {
      await this.sendMedia(next);
    } catch (err: any) {
      const fails = await this.json<Record<string, number>>(K.fails, {});
      fails[next.id] = (fails[next.id] ?? 0) + 1;
      await this.set(K.fails, JSON.stringify(fails));
      throw err;
    }
    const sent = await this.json<string[]>(K.sent, []);
    sent.push(next.id);
    await this.set(K.sent, JSON.stringify(sent.slice(-5000)));
    await this.set(K.last, now.toISOString());
    await this.set(
      K.lastPost,
      JSON.stringify({
        at: now.toISOString(),
        id: next.id,
        type: next.media_type,
        caption: cut(String(next.caption ?? ''), 120),
        permalink: next.permalink ?? null,
        postedOnInstagram: next.timestamp,
      }),
    );
    await this.set(K.lastError, '');
    this.logger.log(`Instagram posti kanalga chiqdi: ${next.id}`);
    return { id: next.id, caption: IgRepostService.caption(next) };
  }

  /** Vaqti kelganmi: oxirgi yuborishdan N kun o'tgan va Toshkentda soat >= sozlangan */
  async isDue(now = new Date()) {
    const s = await this.settings();
    if (!s.enabled) return false;
    const last = Date.parse((await this.get(K.last)) ?? '');
    // Soat chegarasidan biroz oldin ham bo'ladi (tekshiruv soatiga bir)
    if (Number.isFinite(last) && now.getTime() - last < s.days * DAY_MS - HOUR_MS) {
      return false;
    }
    const hour = new Date(now.getTime() + TASHKENT_OFFSET_MS).getUTCHours();
    return hour >= s.hour;
  }

  async runIfDue(now = new Date()) {
    if (this.running) return 'busy';
    if (!this.telegram.configured || !this.instagram.configured) return 'off';
    if (!(await this.isDue(now))) return 'not-due';
    this.running = true;
    try {
      const r = await this.postNext(now);
      // Navbat bo'sh bo'lsa ham "oxirgi tekshiruv" yoziladi — har soat
      // Instagram'ga bekorga so'rov ketmasin (yangi post keyingi davrda chiqadi)
      if (!r) await this.set(K.last, now.toISOString());
      return r ? 'sent' : 'empty';
    } catch (err: any) {
      await this.set(K.lastError, String(err?.message ?? err).slice(0, 300));
      throw err;
    } finally {
      this.running = false;
    }
  }

  // ---------- admin ----------

  async status() {
    const s = await this.settings();
    let pending: number | null = null;
    let next: { id: string; caption: string; type: string; at: string } | null =
      null;
    let error = (await this.get(K.lastError)) || null;
    if (this.instagram.configured) {
      try {
        const q = await this.queue();
        pending = q.length;
        if (q[0]) {
          next = {
            id: q[0].id,
            type: q[0].media_type,
            caption: cut(String(q[0].caption ?? ''), 160),
            at: q[0].timestamp,
          };
        }
      } catch (err: any) {
        error = `Instagram ro'yxati olinmadi: ${err?.message}`;
      }
    }
    const last = await this.get(K.last);
    return {
      ...s,
      telegram: this.telegram.configured,
      instagram: this.instagram.configured,
      sentCount: (await this.json<string[]>(K.sent, [])).length,
      pending,
      next,
      lastPost: await this.json<any>(K.lastPost, null),
      nextRunAfter: last
        ? new Date(Date.parse(last) + s.days * DAY_MS).toISOString()
        : null,
      error,
    };
  }

  async update(body: { enabled?: unknown; days?: unknown; hour?: unknown }) {
    if (typeof body.enabled === 'boolean') {
      await this.set(K.enabled, body.enabled ? '1' : '0');
    }
    const d = Number(body.days);
    if (body.days !== undefined && Number.isInteger(d) && d >= 1 && d <= 30) {
      await this.set(K.days, String(d));
    }
    const h = Number(body.hour);
    if (body.hour !== undefined && Number.isInteger(h) && h >= 0 && h <= 23) {
      await this.set(K.hour, String(h));
    }
    return this.status();
  }
}
