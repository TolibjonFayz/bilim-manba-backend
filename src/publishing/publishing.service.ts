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

// Timer ko'pi bilan shuncha kutadi, keyin bazani qayta tekshiradi
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

/**
 * Maqola chop etilishi bilan bog'liq hamma narsa bir joyda:
 *  - rejalashtirilgan qoralamalarni vaqti kelganda chop etish
 *  - chop etilgandan keyin: email obunachilar, bildirishnomalar, Telegram
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
        await this.publish(a.id);
        this.logger.log(`Rejalashtirilgan maqola chop etildi: ${a.slug}`);
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
    const article = await this.articleModel.findByPk(id);
    if (!article) throw new NotFoundException('Maqola topilmadi');
    if (article.status === ArticleStatus.PUBLISHED) return article;

    await this.articleModel.update(
      { status: ArticleStatus.PUBLISHED, scheduledAt: null },
      { where: { id } },
    );
    await this.articleModel.sequelize!.query(
      'UPDATE articles SET "createdAt" = NOW() WHERE id = :id',
      { replacements: { id } },
    );
    await this.afterPublish(id);
    return this.articleModel.findByPk(id);
  }

  /**
   * Chop etilgandan keyingi ishlar. Har biri alohida — biri yiqilsa (masalan
   * email), qolganlari baribir bajariladi, nashrning o'zi bekor bo'lmaydi.
   */
  async afterPublish(id: number) {
    const article = await this.articleModel.findByPk(id, {
      include: [{ model: Category, attributes: ['id', 'name'] }],
    });
    if (!article || article.status !== ArticleStatus.PUBLISHED) return;

    await this.postToTelegram(article);

    try {
      await this.notifications.createForAllUsers(
        'Yangi maqola chiqdi! 📚',
        article.title,
        `/articles/${article.slug}`,
      );
    } catch (err: any) {
      this.logger.error(`Bildirishnomalar yuborilmadi: ${err?.message}`);
    }

    try {
      const subs = await this.subscribers.getAllActive();
      await Promise.allSettled(
        subs.map((s: any) =>
          this.mailer.sendNewArticleEmail(
            s.email,
            article.title,
            article.slug,
            article.excerpt,
            article.coverImage,
          ),
        ),
      );
    } catch (err: any) {
      this.logger.error(`Email obunachilarga yuborilmadi: ${err?.message}`);
    }
  }

  /**
   * Telegram'ga bir marta yuboradi (telegramPostedAt bo'yicha).
   * force — admin "qayta yuborish" tugmasi uchun.
   */
  async postToTelegram(article: Article, force = false): Promise<boolean> {
    if (article.telegramPostedAt && !force) return false;
    try {
      const sent = await this.telegram.sendArticle(article as any);
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
      nextScheduledAt: this.nextScheduledAt,
    };
  }
}
