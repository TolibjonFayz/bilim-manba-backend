// src/mailer/mailer.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { escHtml, safeUrl } from '../common/html';
import { unsubscribeToken, unsubscribeUrl } from '../common/unsubscribe-token';

/**
 * Email yuborish (SMTP). Env:
 *   MAIL_HOST, MAIL_PORT (465 — SSL, 587 — STARTTLS), MAIL_USER, MAIL_PASS,
 *   MAIL_FROM — jo'natuvchi manzil (bo'lmasa MAIL_USER).
 *
 * 2026-11: Outlook/Hotmail hisoblarida Microsoft SMTP orqali kirishni
 * o'chirib qo'ygan — xatlar ketmay qolgan edi. Tavsiya: Resend
 * (MAIL_HOST=smtp.resend.com, MAIL_PORT=465, MAIL_USER=resend,
 * MAIL_PASS=<API kalit>, MAIL_FROM=noreply@bilimmanba.uz) yoki Gmail
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

  get configured(): boolean {
    return Boolean(this.transporter && this.config.get('MAIL_USER'));
  }

  private get from(): string {
    const addr =
      this.config.get<string>('MAIL_FROM') || this.config.get<string>('MAIL_USER');
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
      this.config.get<string>('MAIL_FROM') || this.config.get<string>('MAIL_USER') || null;
    if (!this.transporter || !this.configured) {
      return {
        configured: false,
        ok: false,
        host,
        from,
        error: 'Pochta sozlanmagan (MAIL_HOST / MAIL_USER / MAIL_PASS yo\'q)',
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
    if (!this.transporter) throw new Error('Pochta sozlanmagan');
    await this.transporter.sendMail({
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

    if (!this.transporter) return false;
    try {
      await this.transporter.sendMail({
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

    if (!this.transporter) {
      this.logger.error('Pochta sozlanmagan — parol tiklash xati yuborilmadi');
      return;
    }
    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject: '🔐 Parolni tiklash — Bilim Manba',
        html,
      });
    } catch (error) {
      this.logger.error(`Reset email yuborishda xato ${to}: ${error?.message}`);
    }
  }
}
