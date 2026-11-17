import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { Article, ArticleStatus } from '../articles/models/article.model';
import { Category } from '../categories/models/category.model';
import { MailerService } from '../mailer/mailer.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubscribersService } from '../subscribers/subscribers.service';
import { TelegramService } from './telegram.service';
import { InstagramService } from './instagram.service';
import { SocialImageService } from './social-image.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { AdminAlertService } from './admin-alert.service';
import { QuizService } from '../quiz/quiz.service';

/**
 * Model nusxasini oddiy obyektga aylantiradi. Article/Category modellarida
 * `category` kabi maydonlar class field qilib e'lon qilingan va Sequelize
 * getter'larini to'sadi — nusxada `article.category` undefined bo'lib qoladi.
 */
const plain = (a: any) =>
  typeof a?.get === 'function' ? a.get({ plain: true }) : a;

// Timer ko'pi bilan shuncha kutadi, keyin bazani qayta tekshiradi
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

/**
 * Maqola chop etilishi bilan bog'liq hamma narsa bir joyda:
 *  - rejalashtirilgan qoralamalarni vaqti kelganda chop etish
 *  - chop etilgandan keyin: Telegram, Instagram (post + story),
 *    bildirishnomalar, email obunachilar
 *
 * Neon bepul tarifida baza ishlatilmasa uxlaydi, shuning uchun bazani har
 * daqiqada so'ramaymiz: eng yaqin scheduledAt vaqtini bilib, aynan o'sha
 * paytga timer qo'yamiz (ko'pi bilan 6 soatda bir tekshiruv).
 */
@Injectable()
export class PublishingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublishingService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  nextScheduledAt: Date | null = null;

  constructor(
    @InjectModel(Article) private readonly articleModel: typeof Article,
    private readonly telegram: TelegramService,
    private readonly subscribers: SubscribersService,
    private readonly mailer: MailerService,
    private readonly notifications: NotificationsService,
    private readonly instagram: InstagramService,
    private readonly socialImages: SocialImageService,
    private readonly cloudinary: CloudinaryService,
    private readonly alerts: AdminAlertService,
    private readonly quiz: QuizService,
  ) {}

  onModuleInit() {
    // Server ishga tushgach (deploy yoki uyg'onish) vaqti o'tganlarni chiqaramiz
    setTimeout(() => void this.tick(), 15000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  /** Vaqti kelgan qoralamalarni chop etadi va keyingi timerni qo'yadi */
  async tick() {
    try {
      await this.publishDue();
    } catch (err: any) {
      this.logger.error(`Rejalashtirilgan nashrda xato: ${err?.message}`);
    }
    // Instagram tokeni muddati o'tmasin (haftada bir yangilanadi)
    await this.instagram.refreshTokenIfNeeded();
    await this.refreshSchedule();
  }

  /** Admin maqolani saqlagandan keyin chaqiriladi — timer yangilanadi */
  async refreshSchedule() {
    try {
      const next = (await this.articleModel.min('scheduledAt', {
        where: { status: ArticleStatus.DRAFT, scheduledAt: { [Op.ne]: null } },
      })) as Date | null;
      this.nextScheduledAt = next ? new Date(next) : null;
    } catch (err: any) {
      this.logger.error(`Jadvalni o'qib bo'lmadi: ${err?.message}`);
    }
    if (this.timer) clearTimeout(this.timer);
    const wait = this.nextScheduledAt
      ? Math.max(1000, this.nextScheduledAt.getTime() - Date.now())
      : MAX_WAIT_MS;
    this.timer = setTimeout(
      () => void this.tick(),
      Math.min(wait, MAX_WAIT_MS),
    );
    this.timer.unref();
  }

  async publishDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.articleModel.findAll({
        where: {
          status: ArticleStatus.DRAFT,
          scheduledAt: { [Op.lte]: new Date() },
        },
        order: [['scheduledAt', 'ASC']],
      });
      for (const a of due) {
        const results = await this.publishWithResults(a.id);
        this.logger.log(`Rejalashtirilgan maqola chop etildi: ${a.slug}`);
        // Rejali nashr admin ko'rmaganda bo'ladi — shaxsiy xabar
        await this.alerts.published(a, results);
      }
      return due.length;
    } finally {
      this.running = false;
    }
  }

  /**
   * Qoralamani hozir chop etadi. Sana — chop etilgan payt (qoralama ancha
   * oldin yaratilgan bo'lishi mumkin, saytda esa nashr sanasi ko'rinishi kerak).
   */
  async publish(id: number) {
    await this.publishWithResults(id);
    return this.articleModel.findByPk(id);
  }

  async publishWithResults(id: number) {
    const article = await this.articleModel.findByPk(id);
    if (!article) throw new NotFoundException('Maqola topilmadi');
    if (article.status === ArticleStatus.PUBLISHED)
      return { telegram: null, instagram: null };

    await this.articleModel.update(
      { status: ArticleStatus.PUBLISHED, scheduledAt: null },
      { where: { id } },
    );
    await this.articleModel.sequelize!.query(
      'UPDATE articles SET "createdAt" = NOW() WHERE id = :id',
      { replacements: { id } },
    );
    return this.afterPublish(id);
  }

  /**
   * Chop etilgandan keyingi ishlar. Har biri alohida — biri yiqilsa (masalan
   * email), qolganlari baribir bajariladi, nashrning o'zi bekor bo'lmaydi.
   */
  async afterPublish(
    id: number,
  ): Promise<{ telegram: boolean | null; instagram: boolean | null }> {
    const article = await this.articleModel.findByPk(id, {
      include: [{ model: Category, attributes: ['id', 'name'] }],
    });
    if (!article || article.status !== ArticleStatus.PUBLISHED)
      return { telegram: null, instagram: null };

    // Maqola oxiridagi test — fonda (AI 10–60 s), nashrni kutdirmaydi
    void this.quiz.generateFor(article.id);

    // null — ulanmagan, false — yuborilmadi (xato loglarda)
    const telegram = this.telegram.configured
      ? (await this.postToTelegram(article)) ||
        Boolean(article.telegramPostedAt)
      : null;
    const insta = await this.postToInstagram(article);
    const instagram = this.instagram.configured
      ? insta.post || Boolean(article.instagramPostedAt)
      : null;

    try {
      await this.notifications.createForAllUsers(
        'Yangi maqola chiqdi! 📚',
        article.title,
        `/articles/${article.slug}`,
      );
    } catch (err: any) {
      this.logger.error(`Bildirishnomalar yuborilmadi: ${err?.message}`);
    }

    // Fonda: obunachilar ko'p bo'lsa nashr javobini kutdirmasin
    void this.sendNewsletter(article);
    return { telegram, instagram };
  }

  /**
   * Obunachilarga "yangi maqola" xati — birma-bir (pochta xizmatlari bir
   * vaqtda ko'p xatni rad etadi). Natija app_settings'ga yoziladi, admin
   * panelda ko'rinadi (avval xatlar jimgina ketmay qolgan edi).
   */
  async sendNewsletter(article: Article) {
    let sent = 0;
    let failed = 0;
    let total = 0;
    this.mailer.lastError = null;
    try {
      const subs = await this.subscribers.getAllActive();
      total = subs.length;
      if (this.mailer.configured) {
        for (const s of subs as any[]) {
          const ok = await this.mailer.sendNewArticleEmail(
            s.email,
            article.title,
            article.slug,
            article.excerpt,
            article.coverImage,
          );
          if (ok) sent++;
          else failed++;
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    } catch (err: any) {
      this.mailer.lastError = String(err?.message ?? err).slice(0, 300);
      this.logger.error(`Email obunachilarga yuborilmadi: ${err?.message}`);
    }
    const result = {
      at: new Date().toISOString(),
      title: article.title,
      slug: article.slug,
      total,
      sent,
      failed,
      configured: this.mailer.configured,
      error: this.mailer.configured
        ? this.mailer.lastError
        : 'Pochta sozlanmagan (MAIL_HOST)',
    };
    if (total && sent === 0) {
      this.logger.error(
        `Yangi maqola xati hech kimga ketmadi (${total} obunachi): ${result.error}`,
      );
    }
    await this.articleModel.sequelize
      ?.query(
        `INSERT INTO app_settings (key, value, "updatedAt") VALUES ('newsletter_last', :v, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
        { replacements: { v: JSON.stringify(result) } },
      )
      .catch(() => {});
    return result;
  }

  /** Admin: eng so'nggi chop etilgan maqola xatini obunachilarga qayta yuborish */
  async resendLatestNewsletter() {
    const article = await this.articleModel.findOne({
      where: { status: ArticleStatus.PUBLISHED },
      order: [['createdAt', 'DESC']],
    });
    if (!article) throw new Error("Chop etilgan maqola yo'q");
    if (!this.mailer.configured) throw new Error('Pochta sozlanmagan');
    return this.sendNewsletter(article);
  }

  /** Admin panel: pochta holati va oxirgi tarqatma natijasi */
  async mailStatus() {
    const [status, subs, last] = await Promise.all([
      this.mailer.status(),
      this.subscribers.getAllActive().then((r) => r.length).catch(() => null),
      this.articleModel.sequelize
        ?.query<{ value: string }>(
          `SELECT value FROM app_settings WHERE key = 'newsletter_last'`,
          { type: 'SELECT' as any },
        )
        .then((r: any[]) => (r[0]?.value ? JSON.parse(r[0].value) : null))
        .catch(() => null),
    ]);
    return { ...status, subscribers: subs, lastNewsletter: last ?? null };
  }

  /**
   * Telegram'ga bir marta yuboradi (telegramPostedAt bo'yicha).
   * force — admin "qayta yuborish" tugmasi uchun.
   */
  async postToTelegram(article: Article, force = false): Promise<boolean> {
    if (article.telegramPostedAt && !force) return false;
    try {
      const sent = await this.telegram.sendArticle(plain(article));
      if (sent) {
        await this.articleModel.update(
          { telegramPostedAt: new Date() },
          { where: { id: article.id } },
        );
      }
      return sent;
    } catch (err: any) {
      this.logger.error(
        `Telegram'ga yuborilmadi (${article.slug}): ${err?.message}`,
      );
      if (force) throw err;
      return false;
    }
  }

  /**
   * Instagram'ga post va story — har biri bir marta (instagram*PostedAt).
   * Rasm serverda yasaladi va Cloudinary'ga yuklanadi (Instagram rasmni
   * ochiq manzildan o'zi yuklab oladi). force — admin "qayta yuborish".
   */
  async postToInstagram(article: Article, force = false) {
    const result = { post: false, story: false };
    if (!this.instagram.configured) {
      if (force)
        throw new Error('Instagram ulanmagan (INSTAGRAM_ACCESS_TOKEN)');
      return result;
    }
    const jobs: { kind: 'post' | 'story'; done: Date | null }[] = [
      { kind: 'post', done: article.instagramPostedAt },
      { kind: 'story', done: article.instagramStoryPostedAt },
    ];
    for (const job of jobs) {
      if (job.done && !force) continue;
      try {
        const format = job.kind === 'post' ? 'feed' : 'story';
        const jpeg = await this.socialImages.render(plain(article), format);
        const url = await this.cloudinary.uploadBuffer(
          jpeg,
          'bilim-manba/social',
          `${article.slug}-${format}`.slice(0, 200),
        );
        await this.instagram.publishImage(url, {
          story: job.kind === 'story',
          caption:
            job.kind === 'post'
              ? this.instagram.buildCaption(plain(article))
              : undefined,
        });
        await this.articleModel.update(
          job.kind === 'post'
            ? { instagramPostedAt: new Date() }
            : { instagramStoryPostedAt: new Date() },
          { where: { id: article.id } },
        );
        result[job.kind] = true;
      } catch (err: any) {
        this.logger.error(
          `Instagram ${job.kind} yuborilmadi (${article.slug}): ${err?.message}`,
        );
        if (force) throw err;
      }
    }
    return result;
  }

  async postToInstagramById(id: number) {
    const article = await this.articleModel.findByPk(id, {
      include: [{ model: Category, attributes: ['id', 'name'] }],
    });
    if (!article) throw new NotFoundException('Maqola topilmadi');
    return this.postToInstagram(article, true);
  }

  /** Admin uchun: Instagram kartochkasini oldindan ko'rish (JPEG) */
  async socialPreview(id: number, format: 'feed' | 'story') {
    const article = await this.articleModel.findByPk(id, {
      include: [{ model: Category, attributes: ['id', 'name'] }],
    });
    if (!article) throw new NotFoundException('Maqola topilmadi');
    return this.socialImages.render(plain(article), format);
  }

  async postToTelegramById(id: number) {
    const article = await this.articleModel.findByPk(id, {
      include: [{ model: Category, attributes: ['id', 'name'] }],
    });
    if (!article) throw new NotFoundException('Maqola topilmadi');
    return { sent: await this.postToTelegram(article, true) };
  }

  status() {
    return {
      telegramConfigured: this.telegram.configured,
      instagramConfigured: this.instagram.configured,
      nextScheduledAt: this.nextScheduledAt,
    };
  }
}
