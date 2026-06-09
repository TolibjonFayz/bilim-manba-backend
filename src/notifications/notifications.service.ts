import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Notification } from './models/notification.model';
import { User } from 'src/users/models/user.model';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification) private notificationModel: typeof Notification,
    @InjectModel(User) private userModel: typeof User,
  ) {}

  // Barcha foydalanuvchilarga bildirishnoma (yangi maqola uchun)
  async createForAllUsers(title: string, message: string, link: string) {
    const users = await this.userModel.findAll({ attributes: ['id'] });

    const rows = users.map((u) => ({
      userId: u.id,
      title,
      message,
      link,
      isRead: false,
    }));

    if (rows.length) {
      await this.notificationModel.bulkCreate(rows as any);
    }
  }

  // Foydalanuvchining bildirishnomalari
  async getUserNotifications(userId: number) {
    return this.notificationModel.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
      limit: 30,
    });
  }

  // O'qilmaganlar soni
  async getUnreadCount(userId: number): Promise<number> {
    return this.notificationModel.count({
      where: { userId, isRead: false },
    });
  }

  // Bittasini o'qilgan deb belgilash
  async markAsRead(userId: number, id: number) {
    await this.notificationModel.update(
      { isRead: true },
      { where: { id, userId } },
    );
    return { message: "O'qilgan deb belgilandi" };
  }

  // Hammasini o'qilgan deb belgilash
  async markAllAsRead(userId: number) {
    await this.notificationModel.update(
      { isRead: true },
      { where: { userId, isRead: false } },
    );
    return { message: "Barchasi o'qilgan deb belgilandi" };
  }
}
