// src/mailer/mailer.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { escHtml, safeUrl } from '../common/html';
import { unsubscribeToken, unsubscribeUrl } from '../common/unsubscribe-token';

/** Xat ichidagi maqola (xush kelibsiz, dayjest) */
export interface MailArticle {
  title: string;
  slug: string;
  excerpt?: string | null;
  coverImage?: string | null;
  category?: string | null;
}

/**
 * Email yuborish (SMTP). Env:
 *   MAIL_HOST, MAIL_PORT (465 — SSL, 587 — STARTTLS), MAIL_USER, MAIL_PASS,
 *   MAIL_FROM — jo'natuvchi manzil (bo'lmasa MAIL_USER).
 *
 * 2026-11: Outlook/Hotmail hisoblarida Microsoft SMTP orqali kirishni
 * o'chirib qo'ygan — xatlar ketmay qolgan edi. Hozir: Resend
 * (MAIL_HOST=smtp.resend.com, MAIL_PASS=<API kalit>, MAIL_FROM=
 * noreply@bilimmanba.uz) — HTTP API orqali yuboriladi, chunki Render bepul
 * tarifi SMTP portlarini yopadi (Gmail SMTP ham shu sabab ishlamaydi).
 * Boshqa SMTP — faqat pullik serverda; masalan Gmail
 * (smtp.gmail.com, 465, ilova paroli).
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private transporter: nodemailer.Transporter | null;

  constructor(private config: ConfigService) {
    const host = this.config.get<string>('MAIL_HOST');
    const port = Number(this.config.get('MAIL_PORT')) || 587;
    this.transporter = host
      ? nodemailer.createTransport({
          host,
          port,
          secure: port === 465,
          requireTLS: port !== 465,
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 30000,
          auth: {
            user: this.config.get('MAIL_USER'),
            pass: this.config.get('MAIL_PASS'),
          },
        })
      : null;
  }

  /**
   * Resend HTTP API (https://api.resend.com/emails). Render'ning bepul
   * tarifi SMTP portlarini (25/465/587) yopadi — smtp.resend.com ga ulanish
   * "Connection timeout" bo'lardi. Shuning uchun Resend bo'lsa SMTP emas,
   * oddiy HTTPS ishlatiladi. Kalit: RESEND_API_KEY yoki (MAIL_HOST resend
   * bo'lsa) MAIL_PASS.
   */
  private get resendKey(): string | null {
    const direct = (this.config.get<string>('RESEND_API_KEY') ?? '').trim();
    if (direct) return direct;
    const host = (this.config.get<string>('MAIL_HOST') ?? '').toLowerCase();
    const pass = (this.config.get<string>('MAIL_PASS') ?? '').trim();
    return host.includes('resend') && pass ? pass : null;
  }

  get configured(): boolean {
    if (this.resendKey) return true;
    return Boolean(this.transporter && this.config.get('MAIL_USER'));
  }

  /** Bitta xatni yuboradi (Resend API yoki SMTP). Xato bo'lsa — otiladi */
  private async deliver(mail: {
    from: string;
    to: string;
    subject: string;
    html: string;
    headers?: Record<string, string>;
  }) {
    const key = this.resendKey;
    if (key) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: mail.from,
          to: [mail.to],
          subject: mail.subject,
          html: mail.html,
          ...(mail.headers ? { headers: mail.headers } : {}),
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        throw new Error(
          `Resend ${res.status}: ${j?.message ?? j?.name ?? 'xato'}`,
        );
      }
      return;
    }
    if (!this.transporter) throw new Error('Pochta sozlanmagan');
    await this.transporter.sendMail(mail);
  }

  private get from(): string {
    const addr =
      this.config.get<string>('MAIL_FROM') ||
      this.config.get<string>('MAIL_USER');
    return `"Bilim Manba" <${addr}>`;
  }

  /** Admin panel uchun: pochta serveriga ulanib, login qilib ko'radi (xat yubormaydi) */
  async status(): Promise<{
    configured: boolean;
    ok: boolean;
    host: string | null;
    from: string | null;
    error: string | null;
  }> {
    const host = this.config.get<string>('MAIL_HOST') ?? null;
    const from =
      this.config.get<string>('MAIL_FROM') ||
      this.config.get<string>('MAIL_USER') ||
      null;
    const key = this.resendKey;
    if (key) {
      // Kalitni tekshirish (xat yubormasdan). Faqat "yuborish" huquqli kalit
      // domenlar ro'yxatini ko'ra olmaydi — "restricted_api_key" ham kalit
      // to'g'ri ekanini bildiradi
      try {
        const res = await fetch('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        });
        const j: any = await res.json().catch(() => ({}));
        const ok = res.ok || j?.name === 'restricted_api_key';
        return {
          configured: true,
          ok,
          host: 'Resend API',
          from,
          error: ok ? null : `Resend: ${j?.message ?? res.status}`,
        };
      } catch (err: any) {
        return {
          configured: true,
          ok: false,
          host: 'Resend API',
          from,
          error: `Resend'ga ulanib bo'lmadi: ${String(err?.message ?? err).slice(0, 200)}`,
        };
      }
    }
    if (!this.transporter || !this.configured) {
      return {
        configured: false,
        ok: false,
        host,
        from,
        error: "Pochta sozlanmagan (MAIL_HOST / MAIL_USER / MAIL_PASS yo'q)",
      };
    }
    try {
      await this.transporter.verify();
      return { configured: true, ok: true, host, from, error: null };
    } catch (err: any) {
      return {
        configured: true,
        ok: false,
        host,
        from,
        error: String(err?.message ?? err).slice(0, 300),
      };
    }
  }

  /** Sinov xati (admin panel). Xato bo'lsa — matni bilan otiladi */
  async sendTest(to: string) {
    if (!this.configured) throw new Error('Pochta sozlanmagan');
    await this.deliver({
      from: this.from,
      to,
      subject: '✅ Bilim Manba — sinov xati',
      html: '<p>Salom! Bu sinov xati. Bilim Manba email yuborish ishlayapti.</p>',
    });
  }

  async sendNewArticleEmail(
    to: string,
    articleTitle: string,
    articleSlug: string,
    excerpt: string,
    coverImage: string,
  ) {
    const articleUrl = `https://bilimmanba.uz/articles/${encodeURIComponent(articleSlug)}`;
    // Matnlar HTML ichiga faqat tozalangan holda qo'yiladi
    const title = escHtml(articleTitle);
    const cover = safeUrl(coverImage);
    const unsubUrl = unsubscribeUrl(to);
    const apiBase = (
      this.config.get<string>('API_URL') ??
      'https://bilim-manba-backend.onrender.com/api'
    ).replace(/\/$/, '');
    const oneClickUrl = `${apiBase}/subscribers/unsubscribe?email=${encodeURIComponent(to)}&token=${unsubscribeToken(to)}`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 0; background: #f4f6fa; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; }
    .header { background: #4338CA; padding: 24px; text-align: center; }
    .header img { width: 48px; }
    .header h1 { color: #fff; margin: 8px 0 0; font-size: 20px; }
    .cover { width: 100%; height: 240px; object-fit: cover; }
    .body { padding: 32px; }
    .body h2 { font-size: 22px; color: #1a1a2e; margin: 0 0 12px; }
    .body p { color: #555; line-height: 1.6; font-size: 15px; }
    .btn { display: inline-block; margin-top: 24px; padding: 12px 32px; background: #4338CA; color: #fff; border-radius: 100px; text-decoration: none; font-weight: 600; font-size: 15px; }
    .footer { padding: 20px 32px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center; }
    .footer a { color: #4338CA; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Bilim Manba</h1>
    </div>
    ${cover ? `<img src="${cover}" alt="${title}" class="cover" />` : ''}
    <div class="body">
      <h2>${title}</h2>
      ${excerpt ? `<p>${escHtml(excerpt)}</p>` : ''}
      <a href="${articleUrl}" class="btn">Maqolani o'qish →</a>
    </div>
    <div class="footer">
      <p>Siz Bilim Manba yangiliklar ro'yxatiga obuna bo'lgansiz.</p>
      <p><a href="${escHtml(unsubUrl)}">Obunani bekor qilish</a></p>
    </div>
  </div>
</body>
</html>`;

    if (!this.configured) return false;
    try {
      await this.deliver({
        from: this.from,
        to,
        subject: `📚 Yangi maqola: ${String(articleTitle).replace(/[\r\n]+/g, ' ')}`,
        html,
        headers: {
          'List-Unsubscribe': `<${oneClickUrl}>, <${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      return true;
    } catch (error) {
      this.logger.error(`Email yuborishda xato ${to}: ${error?.message}`);
      this.lastError = String(error?.message ?? error).slice(0, 300);
      return false;
    }
  }

  /** Oxirgi yuborishdagi xato matni (statistika uchun) */
  lastError: string | null = null;

  async sendResetPasswordEmail(to: string, name: string, resetUrl: string) {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 0; background: #f4f6fa; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; }
    .header { background: #4338CA; padding: 24px; text-align: center; }
    .header h1 { color: #fff; margin: 0; font-size: 20px; }
    .body { padding: 32px; }
    .body h2 { font-size: 20px; color: #1a1a2e; margin: 0 0 12px; }
    .body p { color: #555; line-height: 1.6; font-size: 15px; }
    .btn { display: inline-block; margin-top: 24px; padding: 12px 32px; background: #4338CA; color: #fff; border-radius: 100px; text-decoration: none; font-weight: 600; font-size: 15px; }
    .note { margin-top: 20px; font-size: 13px; color: #999; }
    .footer { padding: 20px 32px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔐 Bilim Manba</h1>
    </div>
    <div class="body">
      <h2>Salom, ${escHtml(name)}!</h2>
      <p>Parolingizni tiklash uchun quyidagi tugmani bosing. Bu havola <strong>1 soat</strong> davomida amal qiladi.</p>
      <a href="${safeUrl(resetUrl)}" class="btn">Parolni tiklash →</a>
      <p class="note">Agar siz bu so'rovni yuborмаган bo'lsangiz, ushbu xatni e'tiborsiz qoldiring.</p>
    </div>
    <div class="footer">
      <p>Bilim Manba — bilimmanba.uz</p>
    </div>
  </div>
</body>
</html>`;

    if (!this.configured) {
      this.logger.error('Pochta sozlanmagan — parol tiklash xati yuborilmadi');
      return;
    }
    try {
      await this.deliver({
        from: this.from,
        to,
        subject: '🔐 Parolni tiklash — Bilim Manba',
        html,
      });
    } catch (error) {
      this.logger.error(`Reset email yuborishda xato ${to}: ${error?.message}`);
    }
  }

  /** Xatlar uchun umumiy ko'rinish (xush kelibsiz, haftalik dayjest) */
  private layout(content: string, footer: string) {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 16px 0; background: #f4f6fa; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; }
    .header { background: #4338CA; padding: 24px; text-align: center; }
    .header h1 { color: #fff; margin: 0; font-size: 20px; }
    .body { padding: 28px 32px; }
    .body h2 { font-size: 21px; color: #1a1a2e; margin: 0 0 12px; }
    .body p { color: #555; line-height: 1.6; font-size: 15px; margin: 0 0 12px; }
    .btn { display: inline-block; margin: 8px 0 4px; padding: 12px 30px; background: #4338CA; color: #fff !important; border-radius: 100px; text-decoration: none; font-weight: 600; font-size: 15px; }
    .list { margin: 20px 0 0; padding: 0; list-style: none; }
    .item { border-top: 1px solid #eee; padding: 14px 0; }
    .item a { color: #1a1a2e; font-weight: 700; font-size: 15px; text-decoration: none; line-height: 1.4; }
    .item img { width: 100%; max-height: 220px; object-fit: cover; border-radius: 8px; margin-bottom: 8px; }
    .item p { color: #666; font-size: 13px; margin: 4px 0 0; line-height: 1.5; }
    .tag { display: inline-block; font-size: 11px; color: #4338CA; background: #eef0ff; border-radius: 100px; padding: 2px 8px; margin-bottom: 4px; }
    .note { font-size: 13px; color: #999; }
    .footer { padding: 18px 32px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center; }
    .footer a { color: #4338CA; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>📚 Bilim Manba</h1></div>
    <div class="body">${content}</div>
    <div class="footer">${footer}</div>
  </div>
</body>
</html>`;
  }

  /** Maqolalar ro'yxati (xat ichida): rasm (birinchisida), sarlavha, qisqa tavsif */
  private articleList(
    items: MailArticle[],
    utm: string,
    firstWithImage = false,
  ) {
    const site = 'https://bilimmanba.uz';
    return `<ul class="list">${items
      .map((a, i) => {
        const url = `${site}/articles/${encodeURIComponent(a.slug)}?utm_source=email&utm_medium=${utm}`;
        const img =
          firstWithImage && i === 0 ? safeUrl(a.coverImage ?? '') : '';
        return `<li class="item">
          ${img ? `<a href="${url}"><img src="${img}" alt="" /></a>` : ''}
          ${a.category ? `<span class="tag">${escHtml(a.category)}</span><br>` : ''}
          <a href="${url}">${escHtml(a.title)}</a>
          ${a.excerpt ? `<p>${escHtml(String(a.excerpt).slice(0, 160))}</p>` : ''}
        </li>`;
      })
      .join('')}</ul>`;
  }

  /**
   * Ro'yxatdan o'tgandan keyingi xat: xush kelibsiz + (email bilan
   * ro'yxatdan o'tganlarga) tasdiqlash tugmasi + eng ko'p o'qilgan maqolalar.
   */
  async sendWelcomeEmail(
    to: string,
    name: string,
    verifyUrl: string | null,
    popular: MailArticle[],
  ) {
    const first = escHtml(
      String(name || '')
        .trim()
        .split(/\s+/)[0] || "do'st",
    );
    const content = `
      <h2>Xush kelibsiz, ${first}! 👋</h2>
      <p>Bilim Manba — o'zbek tilida fan, tarix, kino va boshqa mavzulardagi maqolalar. Har maqola oxirida test bor: yechsangiz ball olasiz va <a href="https://bilimmanba.uz/reyting">reytingga</a> chiqasiz.</p>
      ${
        verifyUrl
          ? `<p>Avval emailingizni tasdiqlang — shunda haftaning eng yaxshi maqolalarini sizga yuborib turamiz:</p>
             <a href="${safeUrl(verifyUrl)}" class="btn">✅ Emailni tasdiqlash</a>
             <p class="note">Havola 7 kun amal qiladi.</p>`
          : ''
      }
      ${popular.length ? `<p style="margin-top:20px"><strong>Boshlash uchun — eng ko'p o'qilganlar:</strong></p>${this.articleList(popular, 'welcome', true)}` : ''}`;
    const footer = `<p>Siz bilimmanba.uz saytida ro'yxatdan o'tdingiz. Agar bu siz bo'lmasangiz, xatni e'tiborsiz qoldiring.</p>`;

    if (!this.configured) {
      this.logger.warn('Pochta sozlanmagan — xush kelibsiz xati yuborilmadi');
      return false;
    }
    try {
      await this.deliver({
        from: this.from,
        to,
        subject: verifyUrl
          ? '👋 Xush kelibsiz! Emailingizni tasdiqlang — Bilim Manba'
          : '👋 Bilim Manbaga xush kelibsiz!',
        html: this.layout(content, footer),
      });
      return true;
    } catch (error) {
      this.logger.error(`Xush kelibsiz xatida xato ${to}: ${error?.message}`);
      this.lastError = String(error?.message ?? error).slice(0, 300);
      return false;
    }
  }

  /** Haftalik dayjest: o'tgan haftaning eng ko'p o'qilgan maqolalari */
  async sendDigestEmail(to: string, items: MailArticle[], weekLabel: string) {
    const unsubUrl = unsubscribeUrl(to);
    const apiBase = (
      this.config.get<string>('API_URL') ??
      'https://bilim-manba-backend.onrender.com/api'
    ).replace(/\/$/, '');
    const oneClickUrl = `${apiBase}/subscribers/unsubscribe?email=${encodeURIComponent(to)}&token=${unsubscribeToken(to)}`;
    const content = `
      <h2>Haftaning eng yaxshi maqolalari 🗞️</h2>
      <p>${escHtml(weekLabel)} — o'quvchilarimiz eng ko'p o'qigan maqolalar. Har birining oxirida test bor: bilimingizni sinab, ball to'plang!</p>
      ${this.articleList(items, 'digest', true)}
      <p style="margin-top:18px"><a href="https://bilimmanba.uz/articles?utm_source=email&utm_medium=digest" class="btn">Barcha maqolalar →</a></p>`;
    const footer = `<p>Siz Bilim Manba haftalik xatlariga obuna bo'lgansiz.</p>
      <p><a href="${escHtml(unsubUrl)}">Obunani bekor qilish</a></p>`;

    if (!this.configured) return false;
    try {
      await this.deliver({
        from: this.from,
        to,
        subject: `🗞️ Haftaning eng yaxshi maqolalari — ${String(
          items[0]?.title ?? 'Bilim Manba',
        )
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 80)}`,
        html: this.layout(content, footer),
        headers: {
          'List-Unsubscribe': `<${oneClickUrl}>, <${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      return true;
    } catch (error) {
      this.logger.error(`Dayjest yuborishda xato ${to}: ${error?.message}`);
      this.lastError = String(error?.message ?? error).slice(0, 300);
      return false;
    }
  }
}
