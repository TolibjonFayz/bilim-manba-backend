import { Injectable, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Subscriber } from './models/subscriber.model';
import { AnalyticsService } from 'src/analytics/analytics.service';

@Injectable()
export class SubscribersService {
  constructor(
    @InjectModel(Subscriber) private subscriberModel: typeof Subscriber,
    private analytics: AnalyticsService,
  ) {}

  async subscribe(email: string, source?: string, path?: string) {
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

  async unsubscribe(email: string) {
    await this.subscriberModel.update(
      { isActive: false },
      { where: { email } },
    );
    return { message: 'Obuna bekor qilindi' };
  }

  async getAllActive() {
    return this.subscriberModel.findAll({
      where: { isActive: true },
      attributes: ['email'],
    });
  }
}
