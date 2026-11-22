import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { MailArticle, MailerService } from '../mailer/mailer.service';
import { isMailable } from './publishing.service';

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Dushanba, soat 10:00 (Toshkent) */
const SEND_DOW = 1;
const SEND_HOUR = 10;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
const ITEMS = 5;
const MIN_ITEMS = 3;

const K = {
  enabled: 'digest_enabled', // 'off' — o'chirilgan
  last: 'digest_last', // oxirgi yuborilgan hafta (dushanba sanasi)
  result: 'digest_last_result',
};

/** Toshkent bo'yicha shu haftaning dushanbasi: "2026-11-23" */
export function weekKey(now = new Date()) {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  const dow = (local.getUTCDay() + 6) % 7; // dushanba = 0
  return new Date(local.getTime() - dow * DAY_MS).toISOString().slice(0, 10);
}

const MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];

/** "16–22-noyabr" (o'tgan hafta, Toshkent) */
export function weekLabel(now = new Date()) {
  const monday = new Date(`${weekKey(now)}T00:00:00Z`);
  const from = new Date(monday.getTime() - 7 * DAY_MS);
  const to = new Date(monday.getTime() - DAY_MS);
  const m = (d: Date) => MONTHS[d.getUTCMonth()];
  return from.getUTCMonth() === to.getUTCMonth()
    ? `${from.getUTCDate()}–${to.getUTCDate()}-${m(to)}`
    : `${from.getUTCDate()}-${m(from)} – ${to.getUTCDate()}-${m(to)}`;
}

/**
 * Haftalik email dayjest: har dushanba 10:00 (Toshkent) o'tgan haftaning
 * eng ko'p o'qilgan maqolalari. Oluvchilar — faol obunachilar va emailini
 * tasdiqlagan foydalanuvchilar (obunani bekor qilganlardan tashqari).
 * Haftasiga bir marta (app_settings digest_last), xato bo'lsa ham qayta
 * yuborilmaydi — hech kim ikki marta xat olmasin.
 */
@Injectable()
export class DigestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DigestService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Testlar uchun: xatlar orasidagi tanaffus */
  gapMs = 600;

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly mailer: MailerService,
  ) {}

  onModuleInit() {
    this.schedule(60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  private async get(key: string) {
    const rows = await this.sequelize.query<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = :key',
      { replacements: { key }, type: QueryTypes.SELECT },
    );
    return rows[0]?.value ?? null;
  }

  private async set(key: string, value: string) {
    await this.sequelize.query(
      `INSERT INTO app_settings (key, value, "updatedAt") VALUES (:key, :value, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      { replacements: { key, value } },
    );
  }

  private schedule(delay?: number) {
    if (this.timer) clearTimeout(this.timer);
    let wait = delay;
    if (wait === undefined) {
      // Keyingi dushanba 10:00 gacha (ko'pi bilan 6 soat — server uxlab qolsa ham tekshiriladi)
      const now = Date.now();
      const local = new Date(now + TASHKENT_OFFSET_MS);
      const dow = local.getUTCDay();
      local.setUTCHours(SEND_HOUR, 1, 0, 0);
      let next =
        local.getTime() -
        TASHKENT_OFFSET_MS +
        ((SEND_DOW - dow + 7) % 7) * DAY_MS;
      if (next <= now) next += 7 * DAY_MS;
      wait = Math.min(next - now, MAX_WAIT_MS);
    }
    this.timer = setTimeout(async () => {
      try {
        await this.runIfDue();
      } catch (err: any) {
        this.logger.warn(`Dayjest: ${err?.message}`);
      }
      this.schedule();
    }, wait);
    this.timer.unref();
  }

  /** Dushanba 10:00 dan keyin (shu hafta) hali yuborilmagan bo'lsa — yuboradi */
  async runIfDue(now = new Date()) {
    if (this.running || !this.mailer.configured) return 'skipped';
    if ((await this.get(K.enabled)) === 'off') return 'skipped';
    const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
    const dow = local.getUTCDay();
    // Dushanba 10:00 dan keyin yoki hafta davomida (server dushanba uxlab qolgan bo'lsa) —
    // lekin yakshanba kechqurun emas: faqat dushanba–chorshanba
    const daysSinceMonday = (dow + 6) % 7;
    if (daysSinceMonday > 2) return 'skipped';
    if (daysSinceMonday === 0 && local.getUTCHours() < SEND_HOUR)
      return 'skipped';
    const week = weekKey(now);
    if ((await this.get(K.last)) === week) return 'skipped';

    this.running = true;
    try {
      await this.set(K.last, week);
      const result = await this.send(now);
      await this.set(K.result, JSON.stringify({ week, ...result }));
      return result.sent ? 'sent' : 'failed';
    } finally {
      this.running = false;
    }
  }

  /** O'tgan 7 kunda chop etilgan eng ko'p o'qilganlar; kam bo'lsa — 30 kunlik bilan to'ldiriladi */
  async items(now = new Date()): Promise<MailArticle[]> {
    const q = (days: number, exclude: string[], limit: number) =>
      this.sequelize.query<MailArticle>(
        `SELECT a.title, a.slug, a.excerpt, a."coverImage", c.name AS category
         FROM articles a LEFT JOIN categories c ON c.id = a."categoryId"
         WHERE a.status = 'published'
           AND COALESCE(a."scheduledAt", a."createdAt") >= :since
           AND COALESCE(a."scheduledAt", a."createdAt") <= :now
           ${exclude.length ? 'AND a.slug NOT IN (:exclude)' : ''}
         ORDER BY a."viewCount" DESC LIMIT :limit`,
        {
          replacements: {
            since: new Date(now.getTime() - days * DAY_MS),
            now,
            exclude,
            limit,
          },
          type: QueryTypes.SELECT,
        },
      );
    const week = await q(7, [], ITEMS);
    if (week.length >= ITEMS) return week;
    const more = await q(
      30,
      week.map((a) => a.slug),
      ITEMS - week.length,
    );
    return [...week, ...more];
  }

  /** Oluvchilar: faol obunachilar + tasdiqlangan foydalanuvchilar − obunani bekor qilganlar */
  async recipients(): Promise<string[]> {
    const rows = await this.sequelize.query<{ email: string }>(
      `SELECT DISTINCT lower(trim(email)) AS email FROM (
         SELECT email FROM subscribers WHERE "isActive" = true
         UNION
         SELECT email FROM users
         WHERE "emailVerifiedAt" IS NOT NULL AND "isActive" = true
       ) t
       WHERE lower(trim(email)) NOT IN (
         SELECT lower(trim(email)) FROM subscribers WHERE "isActive" = false
       )`,
      { type: QueryTypes.SELECT },
    );
    return rows.map((r) => r.email).filter(isMailable);
  }

  async send(now = new Date()) {
    const items = await this.items(now);
    const base = {
      at: now.toISOString(),
      items: items.length,
      total: 0,
      sent: 0,
      failed: 0,
    };
    if (items.length < MIN_ITEMS) {
      this.logger.warn(`Dayjest yuborilmadi: maqolalar kam (${items.length})`);
      return { ...base, error: 'Maqolalar yetarli emas' };
    }
    const to = await this.recipients();
    const label = weekLabel(now);
    let sent = 0;
    let failed = 0;
    for (const email of to) {
      if (await this.mailer.sendDigestEmail(email, items, label)) sent++;
      else failed++;
      if (this.gapMs) await new Promise((r) => setTimeout(r, this.gapMs));
    }
    this.logger.log(`Haftalik dayjest: ${sent}/${to.length} yuborildi`);
    return {
      ...base,
      total: to.length,
      sent,
      failed,
      error: failed ? this.mailer.lastError : null,
    };
  }

  /** Admin: yoqish/o'chirish */
  async setEnabled(on: boolean) {
    await this.set(K.enabled, on ? 'on' : 'off');
    return this.status();
  }

  /** Admin panel: holat va oxirgi natija */
  async status() {
    const [enabled, last] = await Promise.all([
      this.get(K.enabled),
      this.get(K.result),
    ]);
    return {
      enabled: enabled !== 'off',
      last: last ? JSON.parse(last) : null,
    };
  }
}
