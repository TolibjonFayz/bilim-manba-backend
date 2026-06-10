// src/mailer/mailer.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private transporter: nodemailer.Transporter;

  constructor(private config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get('MAIL_HOST'),
      port: Number(this.config.get('MAIL_PORT')),
      secure: false,
      auth: {
        user: this.config.get('MAIL_USER'),
        pass: this.config.get('MAIL_PASS'),
      },
    });
  }

  async sendNewArticleEmail(
    to: string,
    articleTitle: string,
    articleSlug: string,
    excerpt: string,
    coverImage: string,
  ) {
    const articleUrl = `https://bilimmanba.uz/articles/${articleSlug}`;

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
    ${coverImage ? `<img src="${coverImage}" alt="${articleTitle}" class="cover" />` : ''}
    <div class="body">
      <h2>${articleTitle}</h2>
      <p>${excerpt}</p>
      <a href="${articleUrl}" class="btn">Maqolani o'qish →</a>
    </div>
    <div class="footer">
      <p>Siz Bilim Manba yangiliklar ro'yxatiga obuna bo'lgansiz.</p>
      <p><a href="https://bilimmanba.uz/unsubscribe?email=${to}">Obunani bekor qilish</a></p>
    </div>
  </div>
</body>
</html>`;

    try {
      await this.transporter.sendMail({
        from: `"Bilim Manba" <${this.config.get('MAIL_USER')}>`,
        to,
        subject: `📚 Yangi maqola: ${articleTitle}`,
        html,
      });
    } catch (error) {
      this.logger.error(`Email yuborishda xato ${to}: ${error?.message}`);
    }
  }

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
      <h2>Salom, ${name}!</h2>
      <p>Parolingizni tiklash uchun quyidagi tugmani bosing. Bu havola <strong>1 soat</strong> davomida amal qiladi.</p>
      <a href="${resetUrl}" class="btn">Parolni tiklash →</a>
      <p class="note">Agar siz bu so'rovni yuborмаган bo'lsangiz, ushbu xatni e'tiborsiz qoldiring.</p>
    </div>
    <div class="footer">
      <p>Bilim Manba — bilimmanba.uz</p>
    </div>
  </div>
</body>
</html>`;

    try {
      await this.transporter.sendMail({
        from: `"Bilim Manba" <${this.config.get('MAIL_USER')}>`,
        to,
        subject: '🔐 Parolni tiklash — Bilim Manba',
        html,
      });
    } catch (error) {
      this.logger.error(`Reset email yuborishda xato ${to}: ${error?.message}`);
    }
  }
}
