import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ConfigService } from '@nestjs/config';
import { SubscriptionPlan, User } from 'src/users/models/user.model';

const PREMIUM_PRICE_TIYIN = 1500000;
const PREMIUM_MONTHS = 1;

@Injectable()
export class PaymentService {
  constructor(
    @InjectModel(User) private userModel: typeof User,
    private config: ConfigService,
  ) {}

  // To'lov muvaffaqiyatli bo'lgandan keyin premium berish
  async grantPremium(userId: number) {
    const user = await this.userModel.findByPk(userId);
    if (!user) throw new NotFoundException('User topilmadi');

    const now = new Date();
    const baseDate =
      user.premiumExpiresAt && user.premiumExpiresAt > now
        ? user.premiumExpiresAt
        : now;

    const premiumExpiresAt = new Date(baseDate);
    premiumExpiresAt.setMonth(premiumExpiresAt.getMonth() + PREMIUM_MONTHS);

    await user.update({ plan: SubscriptionPlan.PREMIUM, premiumExpiresAt });

    return user;
  }

  // Summa to'g'rimi tekshirish
  validateAmount(amount: number): boolean {
    return amount === PREMIUM_PRICE_TIYIN;
  }

  getPremiumPrice() {
    return PREMIUM_PRICE_TIYIN;
  }
}
