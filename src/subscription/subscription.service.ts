import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SubscriptionPlan, User } from 'src/users/models/user.model';
import { ActivatePremiumDto } from './dto/activate-premium.dto';
import { InjectModel } from '@nestjs/sequelize';

@Injectable()
export class SubscriptionService {
  constructor(@InjectModel(User) private userModel: typeof User) {}

  // User'ning hozirgi subscription holatini ko'rish
  async getStatus(userId: number) {
    const user = await this.userModel.findByPk(userId, {
      attributes: ['id', 'fullName', 'email', 'plan', 'premiumExpiresAt'],
    });
    if (!user) throw new NotFoundException('User topilmadi');

    const now = new Date();

    // premiumExpiresAt o'tib ketgan bo'lsa — avtomatik free ga tushiramiz
    if (
      user.plan === SubscriptionPlan.PREMIUM &&
      user.premiumExpiresAt &&
      user.premiumExpiresAt < now
    ) {
      await user.update({
        plan: SubscriptionPlan.FREE,
        premiumExpiresAt: null,
      });
      return { ...user.toJSON(), plan: 'free', isExpired: true };
    }

    return {
      ...user.toJSON(),
      // Necha kun qolganini ham qaytaramiz — frontend uchun qulay
      daysLeft: user.premiumExpiresAt
        ? Math.ceil(
            (user.premiumExpiresAt.getTime() - now.getTime()) /
              (1000 * 60 * 60 * 24),
          )
        : null,
    };
  }

  // Admin: qo'lda premium berish (Payme/Click integratsiyadan oldin shu kerak)
  async activatePremium(userId: number, dto: ActivatePremiumDto) {
    const user = await this.userModel.findByPk(userId);
    if (!user) throw new NotFoundException('User topilmadi');

    const now = new Date();

    // Agar hali aktiv premium bo'lsa — ustiga qo'shamiz (uzaytiramiz)
    const baseDate =
      user.premiumExpiresAt && user.premiumExpiresAt > now
        ? user.premiumExpiresAt
        : now;

    const premiumExpiresAt = new Date(baseDate);
    premiumExpiresAt.setMonth(premiumExpiresAt.getMonth() + dto.months);

    await user.update({
      plan: SubscriptionPlan.PREMIUM,
      premiumExpiresAt,
    });

    return {
      message: `${dto.months} oy premium faollashtirildi`,
      plan: user.plan,
      premiumExpiresAt: user.premiumExpiresAt,
    };
  }

  // Admin: premiumni bekor qilish
  async deactivatePremium(userId: number) {
    const user = await this.userModel.findByPk(userId);
    if (!user) throw new NotFoundException('User topilmadi');

    if (user.plan === SubscriptionPlan.FREE) {
      throw new BadRequestException('User allaqachon free planda');
    }

    await user.update({ plan: SubscriptionPlan.FREE, premiumExpiresAt: null });

    return { message: 'Premium bekor qilindi' };
  }

  // Admin: barcha premium userlarni ko'rish
  findAllPremiumUsers() {
    return this.userModel.findAll({
      where: { plan: SubscriptionPlan.PREMIUM },
      attributes: ['id', 'fullName', 'email', 'plan', 'premiumExpiresAt'],
      order: [['premiumExpiresAt', 'ASC']], // Eng tez tugaydigani birinchi
    });
  }
}
