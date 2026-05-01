import { Injectable, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Subscriber } from './models/subscriber.model';

@Injectable()
export class SubscribersService {
  constructor(
    @InjectModel(Subscriber) private subscriberModel: typeof Subscriber,
  ) {}

  async subscribe(email: string) {
    const existing = await this.subscriberModel.findOne({ where: { email } });
    if (existing) {
      if (!existing.isActive) {
        await existing.update({ isActive: true });
        return { message: 'Obuna qayta faollashtirildi!' };
      }
      throw new ConflictException("Bu email allaqachon obuna bo'lgan");
    }
    await this.subscriberModel.create({ email });
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
