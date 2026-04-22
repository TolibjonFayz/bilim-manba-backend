import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ArticleView } from 'src/article-views/models/article-view.model';
import { UpdateUserDto, UpdatePasswordDto } from './dto/update-user.dto';
import { Article } from 'src/articles/models/article.model';
import { Like } from 'src/likes/models/like.model';
import { User } from './models/user.model';
import * as bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import { Category } from 'src/categories/models/category.model';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(ArticleView) private articleViewModel: typeof ArticleView,
    @InjectModel(Like) private likeModel: typeof Like,
    @InjectModel(Article) private articleModel: typeof Article,
  ) {}

  //Create user
  async create(data: Partial<User>) {
    return await this.userModel.create(data as any);
  }

  //Get user by email
  async findByEmail(email: string) {
    return await this.userModel.findOne({ where: { email } });
  }

  //Get user by id
  async findById(id: number) {
    const user = await this.userModel.findByPk(id, {
      attributes: [
        'id',
        'fullName',
        'email',
        'role',
        'plan',
        'premiumExpiresAt',
        'createdAt',
      ],
    });
    if (!user) throw new NotFoundException('User topilmadi');
    return user;
  }

  // Profilni yangilash
  async updateMe(userId: number, dto: UpdateUserDto) {
    const user = await this.userModel.findByPk(userId);
    if (!user) throw new NotFoundException('User topilmadi');
    await user.update(dto);
    return await this.findById(userId);
  }

  // Parolni o'zgartirish
  async updatePassword(userId: number, dto: UpdatePasswordDto) {
    const user = await this.userModel.findByPk(userId);

    if (!user) throw new NotFoundException('User topilmadi');

    const match = await bcrypt.compare(
      dto.currentPassword,
      user.dataValues.password,
    );
    if (!match) throw new BadRequestException("Joriy parol noto'g'ri");

    const hashed = await bcrypt.hash(dto.newPassword, 10);
    await user.update({ password: hashed });
    return { message: "Parol muvaffaqiyatli o'zgartirildi" };
  }

  // User statistikasi
  async getStats(userId: number) {
    const [readCount, savedCount] = await Promise.all([
      // O'qilgan unique maqolalar soni
      this.articleViewModel.count({
        where: { userId },
        distinct: true,
        col: 'articleId',
      }),
      // Like qilgan maqolalar soni
      this.likeModel.count({ where: { userId } }),
    ]);

    // O'rtacha o'qish vaqti — taxminan 5 daqiqa/maqola
    const totalTime = +((readCount * 5) / 60).toFixed(1);

    return { readCount, savedCount, totalTime };
  }

  // So'nggi o'qilgan maqolalar
  async getRecentReads(userId: number, limit = 12) {
    // 1. Views bormi tekshiramiz
    const views = await this.articleViewModel.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
      limit: 12,
      include: { all: true },
    });

    if (!views.length) return [];

    return views;
  }

  // Haftalik faollik — oxirgi 7 kun
  async getWeeklyActivity(userId: number) {
    const weekDays = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];

    // Tashkent UTC+5 ni hisobga olamiz
    const now = new Date();
    const tashkentOffset = 5 * 60 * 60 * 1000; // +5 soat
    const today = new Date(now.getTime() + tashkentOffset);

    // Dushanbani topamiz
    const dayOfWeek = today.getUTCDay(); // 0=Ya, 1=Du...
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(today);
    monday.setUTCDate(today.getUTCDate() - daysFromMonday);
    monday.setUTCHours(0, 0, 0, 0);

    const views = await this.articleViewModel.findAll({
      where: {
        userId,
        createdAt: { [Op.gte]: new Date(monday.getTime() - tashkentOffset) },
      },
      attributes: ['createdAt'],
    });

    const result = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(monday);
      date.setUTCDate(monday.getUTCDate() + i);

      const dateStr = date.toISOString().split('T')[0]; // "2026-04-20"

      const dayViews = views.filter((v) => {
        const vDate = new Date(
          new Date(v.createdAt).getTime() + tashkentOffset,
        );
        return vDate.toISOString().split('T')[0] === dateStr;
      });

      return {
        label: weekDays[i],
        value: dayViews.length,
        date: dateStr,
      };
    });

    const totalThisWeek = result.reduce((sum, d) => sum + d.value, 0);
    return { days: result, totalThisWeek };
  }
}
