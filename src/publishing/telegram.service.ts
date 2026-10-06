import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TelegramArticle {
  title: string;
  slug: string;
  excerpt?: string | null;
  coverImage?: string | null;
  tags?: string | null;
  category?: { name?: string } | null;
}

const CAPTION_LIMIT = 1024; // Telegram rasm izohi chegarasi

/**
 * Maqolani Telegram kanalga post qiladi (Bot API).
 *
 * Kerakli env (Render → Environment):
 *   TELEGRAM_BOT_TOKEN   — @BotFather bergan token
 *   TELEGRAM_CHANNEL_ID  — @bilim_manba (bot kanalda admin bo'lishi shart)
 * Ixtiyoriy: SITE_URL (default https://bilimmanba.uz)
 *
 * Sozlanmagan bo'lsa hech narsa yubormaydi — sayt odatdagidek ishlayveradi.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(private readonly config: ConfigService) {}

  private get token() {
    return this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
  }

  private get channel() {
    return this.config.get<string>('TELEGRAM_CHANNEL_ID') ?? '';
  }

  private get siteUrl() {
    return (
      this.config.get<string>('SITE_URL') ?? 'https://bilimmanba.uz'
    ).replace(/\/$/, '');
  }

  get configured(): boolean {
    return Boolean(this.token && this.channel);
  }

  articleUrl(slug: string) {
    // utm — Google Analytics'da Telegram'dan kelganlar alohida ko'rinsin
    // (canonical query'siz, SEO'ga ta'sir qilmaydi)
    return `${this.siteUrl}/articles/${slug}?utm_source=telegram&utm_medium=channel`;
  }

  buildCaption(a: TelegramArticle): string {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const hashtags = String(a.tags ?? '')
      .split(',')
      .map((t) =>
        t
          .trim()
          .replace(/['ʻʼ‘’`]/g, '')
          .replace(/[^\p{L}\p{N}]+/gu, '_'),
      )
      .map((t) => t.replace(/^_+|_+$/g, ''))
      .filter((t) => t.length > 1)
      .slice(0, 5)
      .map((t) => `#${t}`)
      .join(' ');

    const head = `<b>${esc(a.title)}</b>`;
    const meta = [
      a.category?.name ? `📂 ${esc(a.category.name)}` : '',
      hashtags,
    ]
      .filter(Boolean)
      .join('\n');

    let excerpt = esc(String(a.excerpt ?? '').trim());
    const fixed = head.length + meta.length + 6;
    if (fixed + excerpt.length > CAPTION_LIMIT) {
      excerpt =
        excerpt
          .slice(0, Math.max(0, CAPTION_LIMIT - fixed - 1))
          .replace(/\s+\S*$/, '') + '…';
    }
    return [head, excerpt, meta].filter(Boolean).join('\n\n');
  }

  private coverUrl(url?: string | null) {
    if (!url) return null;
    // Telegram rasmni o'zi yuklab oladi — JPEG, 1280px, yengil bo'lsin
    return url.includes('res.cloudinary.com') && url.includes('/upload/')
      ? url.replace('/upload/', '/upload/f_jpg,q_auto,c_limit,w_1280/')
      : url;
  }

  private async call(method: string, body: Record<string, unknown>) {
    const res = await fetch(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    }
    return json.result;
  }

  /** Maqolani kanalga yuboradi. Sozlanmagan bo'lsa false qaytaradi. */
  async sendArticle(a: TelegramArticle): Promise<boolean> {
    if (!this.configured) {
      this.logger.warn(
        "Telegram sozlanmagan (TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID) — post o'tkazib yuborildi",
      );
      return false;
    }
    const caption = this.buildCaption(a);
    const reply_markup = {
      inline_keyboard: [
        [{ text: "📖 Maqolani o'qish", url: this.articleUrl(a.slug) }],
      ],
    };
    const photo = this.coverUrl(a.coverImage);

    if (photo) {
      try {
        await this.call('sendPhoto', {
          chat_id: this.channel,
          photo,
          caption,
          parse_mode: 'HTML',
          reply_markup,
        });
        return true;
      } catch (err: any) {
        // Rasm yuklanmasa ham post chiqsin — matn ko'rinishida
        this.logger.warn(
          `Rasm bilan yuborilmadi, matn bilan yuboriladi: ${err?.message}`,
        );
      }
    }
    await this.call('sendMessage', {
      chat_id: this.channel,
      text: caption,
      parse_mode: 'HTML',
      reply_markup,
    });
    return true;
  }
}
