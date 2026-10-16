import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/sequelize';
import { randomBytes } from 'crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TelegramService } from './telegram.service';

const CHAT_KEY = 'admin_telegram_chat_id';
const LINK_KEY = 'admin_telegram_link';
const OFFSET_KEY = 'admin_telegram_offset';
// Ulash havolasi shuncha vaqt amal qiladi
const LINK_TTL_MS = 15 * 60 * 1000;

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Adminning o'ziga Telegram orqali shaxsiy xabarlar: AI qoralama tayyor yoki
 * yozilmadi, maqola chop etildi (Telegram/Instagram natijasi bilan).
 *
 * Ulash: admin panelda "Telegram'ga ulash" → bot havolasi (t.me/<bot>?start=<kod>)
 * → admin botda Start bosadi → panel getUpdates orqali kodni topib, chat ID ni
 * app_settings ga yozadi. Webhook va doimiy so'rov kerak emas.
 * Zaxira: env TELEGRAM_ADMIN_CHAT_ID.
 *
 * Xabar yuborilmasa ham asosiy ish (nashr, qoralama) to'xtamaydi.
 */
@Injectable()
export class AdminAlertService {
  private readonly logger = new Logger(AdminAlertService.name);
  private botUsername?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly telegram: TelegramService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  private get siteUrl() {
    return (
      this.config.get<string>('SITE_URL') ?? 'https://bilimmanba.uz'
    ).replace(/\/$/, '');
  }

  private async getSetting(key: string): Promise<string | null> {
    const rows = await this.sequelize.query<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = :key',
      { replacements: { key }, type: QueryTypes.SELECT },
    );
    return rows[0]?.value ?? null;
  }

  private async setSetting(key: string, value: string) {
    await this.sequelize.query(
      `INSERT INTO app_settings (key, value, "updatedAt") VALUES (:key, :value, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      { replacements: { key, value } },
    );
  }

  private async chatId(): Promise<string | null> {
    try {
      return (
        (await this.getSetting(CHAT_KEY)) ||
        this.config.get<string>('TELEGRAM_ADMIN_CHAT_ID') ||
        null
      );
    } catch {
      return this.config.get<string>('TELEGRAM_ADMIN_CHAT_ID') || null;
    }
  }

  async status() {
    return {
      botConfigured: this.telegram.hasBot,
      linked: Boolean(await this.chatId()),
    };
  }

  /** Admin panel uchun: botga Start bosish havolasi */
  async createLink() {
    if (!this.telegram.hasBot) {
      throw new ServiceUnavailableException(
        'Telegram bot sozlanmagan (TELEGRAM_BOT_TOKEN)',
      );
    }
    if (!this.botUsername) {
      try {
        const me = await this.telegram.call('getMe', {});
        this.botUsername = me.username;
      } catch (err: any) {
        throw new ServiceUnavailableException(
          `Telegram bot javob bermadi: ${err?.message}`,
        );
      }
    }
    const code = randomBytes(9).toString('base64url');
    await this.setSetting(
      LINK_KEY,
      JSON.stringify({ code, expires: Date.now() + LINK_TTL_MS }),
    );
    return { url: `https://t.me/${this.botUsername}?start=${code}` };
  }

  /**
   * Admin botda Start bosdimi — getUpdates'dan kodni qidiradi. Topilsa chat ID
   * saqlanadi va tasdiq xabari yuboriladi.
   */
  async checkLink(): Promise<{ linked: boolean }> {
    const raw = await this.getSetting(LINK_KEY);
    const link = raw
      ? (JSON.parse(raw) as { code: string; expires: number })
      : null;
    if (!link || link.expires < Date.now()) {
      return { linked: Boolean(await this.chatId()) };
    }
    const offset = Number(await this.getSetting(OFFSET_KEY)) || 0;
    let updates: any[];
    try {
      updates = await this.telegram.call('getUpdates', {
        offset,
        timeout: 0,
        allowed_updates: ['message'],
      });
    } catch (err: any) {
      // Masalan, botga webhook o'rnatilgan bo'lsa getUpdates ishlamaydi
      throw new ServiceUnavailableException(
        `Botdan xabarlarni o'qib bo'lmadi: ${err?.message}`,
      );
    }
    let found: string | null = null;
    let last = offset - 1;
    for (const u of updates) {
      last = Math.max(last, u.update_id);
      const text = String(u.message?.text ?? '').trim();
      if (
        u.message?.chat?.type === 'private' &&
        text === `/start ${link.code}`
      ) {
        found = String(u.message.chat.id);
      }
    }
    if (updates.length) await this.setSetting(OFFSET_KEY, String(last + 1));
    if (!found) return { linked: false };

    await this.setSetting(CHAT_KEY, found);
    await this.setSetting(LINK_KEY, '');
    await this.send(
      "✅ <b>Bilim Manba admin xabarlari ulandi</b>\n\nEndi AI qoralama tayyor bo'lganda, yozilmay qolganda va maqola chop etilganda shu yerga xabar keladi.",
    );
    return { linked: true };
  }

  async unlink() {
    await this.setSetting(CHAT_KEY, '');
    return { linked: Boolean(await this.chatId()) };
  }

  /** Xabar yuboradi; ulanmagan bo'lsa jim o'tadi. Hech qachon xato otmaydi */
  async send(html: string, button?: { text: string; path: string }) {
    try {
      if (!this.telegram.hasBot) return false;
      const chat = await this.chatId();
      if (!chat) return false;
      await this.telegram.call('sendMessage', {
        chat_id: chat,
        text: html.slice(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(button
          ? {
              reply_markup: {
                inline_keyboard: [
                  [{ text: button.text, url: `${this.siteUrl}${button.path}` }],
                ],
              },
            }
          : {}),
      });
      return true;
    } catch (err: any) {
      this.logger.warn(`Admin xabari yuborilmadi: ${err?.message}`);
      return false;
    }
  }

  draftReady(a: { id?: number; title: string }, daily: boolean) {
    return this.send(
      `✍️ <b>${daily ? 'Kunlik' : 'Yangi'} AI qoralama tayyor</b>\n\n${esc(a.title)}\n\nO'qib chiqing va chop eting yoki vaqtini belgilang.`,
      { text: "👀 Ko'rib chiqish", path: `/admin/articles/${a.id}/preview` },
    );
  }

  draftFailed(error: string, topic?: string, daily = false) {
    return this.send(
      `⚠️ <b>${daily ? 'Kunlik ' : ''}AI qoralama yozilmadi</b>${topic ? `\n\nMavzu: ${esc(topic)}` : ''}\n\n<i>${esc(error).slice(0, 600)}</i>`,
      { text: '⚙️ Admin panel', path: '/admin/articles' },
    );
  }

  draftSkipped(message: string) {
    return this.send(
      `⏸ <b>Kunlik AI qoralama yozilmadi</b>\n\n${esc(message)}`,
      {
        text: "📝 Qoralamalarni ko'rish",
        path: '/admin/articles',
      },
    );
  }

  published(
    a: { title: string; slug: string },
    results: { telegram: boolean | null; instagram: boolean | null },
  ) {
    const mark = (v: boolean | null) =>
      v === null ? '— ulanmagan' : v ? '✅' : '❌ yuborilmadi';
    return this.send(
      `📢 <b>Maqola chop etildi</b>\n\n${esc(a.title)}\n\nTelegram kanal: ${mark(results.telegram)}\nInstagram: ${mark(results.instagram)}`,
      { text: "📖 Saytda ko'rish", path: `/articles/${a.slug}` },
    );
  }
}
