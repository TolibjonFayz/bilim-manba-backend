import {
  Injectable,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Subscriber } from './models/subscriber.model';
import { AnalyticsService } from 'src/analytics/analytics.service';
import { checkUnsubscribeToken } from '../common/unsubscribe-token';

@Injectable()
export class SubscribersService {
  constructor(
    @InjectModel(Subscriber) private subscriberModel: typeof Subscriber,
    private analytics: AnalyticsService,
  ) {}

  async subscribe(email: string, source?: string, path?: string) {
    email = email.trim();
    const existing = await this.subscriberModel.findOne({ where: { email } });
    if (existing) {
      if (!existing.isActive) {
        await existing.update({ isActive: true });
        await this.analytics.markSignup('subscribers', email, source, path);
        return { message: 'Obuna qayta faollashtirildi!' };
      }
      throw new ConflictException("Bu email allaqachon obuna bo'lgan");
    }
    await this.subscriberModel.create({ email });
    await this.analytics.markSignup('subscribers', email, source, path);
    return { message: "Muvaffaqiyatli obuna bo'ldingiz!" };
  }

  async unsubscribe(email: string, token: string) {
    if (!checkUnsubscribeToken(email, token)) {
      throw new BadRequestException(
        "Havola noto'g'ri yoki eskirgan. Eng so'nggi xatdagi havoladan foydalaning.",
      );
    }
    const updated = await this.subscriberModel.update(
      { isActive: false },
      { where: { email: email.trim() } },
    );
    // Obunachi bo'lmagan (ro'yxatdan o'tgan foydalanuvchi) — haftalik dayjest
    // unga qayta ketmasligi uchun "bekor qilgan" sifatida eslab qolinadi
    if (!updated[0]) {
      await this.subscriberModel
        .create({ email: email.trim(), isActive: false } as any)
        .catch(() => {});
    }
    return { message: 'Obuna bekor qilindi' };
  }

  async getAllActive() {
    return this.subscriberModel.findAll({
      where: { isActive: true },
      attributes: ['email'],
    });
  }
}
