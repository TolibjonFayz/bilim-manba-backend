import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from 'sequelize-typescript';
import { Category } from 'src/categories/models/category.model';
import { User } from 'src/users/models/user.model';

export enum ArticleStatus {
  DRAFT = 'draft', // Hali chiqmagan, faqat admin ko'radi
  PUBLISHED = 'published', // Hammaga ko'rinadi
}

export enum ArticleType {
  FREE = 'free', // Hamma o'qiydi
  PREMIUM = 'premium', // Faqat premium userlar
}

@Table({ tableName: 'articles', timestamps: true })
export class Article extends Model {
  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  @Column({ type: DataType.STRING, unique: true, allowNull: false })
  declare slug: string;

  // Qisqa tavsif: kartochka, meta description, Google natijasi
  @Column({ type: DataType.TEXT, allowNull: true })
  declare excerpt: string;

  // Manba: "Quanta Magazine (Ben Brubaker)", "Claude AI" ...
  // Ustun DataMigrationsService orqali qo'shiladi (synchronize ustun qo'shmaydi)
  @Column({ type: DataType.STRING, allowNull: true })
  declare source: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare content: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare coverImage: string;

  @Column({ type: DataType.ENUM(...Object.values(ArticleType)) })
  declare type: ArticleType;

  @Column({
    type: DataType.ENUM(...Object.values(ArticleStatus)),
    defaultValue: ArticleStatus.DRAFT,
  })
  declare status: ArticleStatus;

  @Column({ type: DataType.INTEGER, defaultValue: 0 })
  declare viewCount: number;

  // Qoralama shu vaqtda avtomatik chop etiladi (PublishingService).
  // Ustunlar DataMigrationsService.ensureSchema orqali qo'shiladi.
  @Column({ type: DataType.DATE, allowNull: true })
  declare scheduledAt: Date | null;

  // Telegram kanalga yuborilgan vaqt — bir maqola ikki marta ketmasin
  @Column({ type: DataType.DATE, allowNull: true })
  declare telegramPostedAt: Date | null;

  // Instagram post va story yuborilgan vaqt
  @Column({ type: DataType.DATE, allowNull: true })
  declare instagramPostedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare instagramStoryPostedAt: Date | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare tags: string;

  @ForeignKey(() => Category)
  @Column({ type: DataType.INTEGER })
  declare categoryId: number;

  @Column({ type: DataType.INTEGER, defaultValue: 0 })
  declare likeCount: number;

  @ForeignKey(() => User)
  @Column({ type: DataType.INTEGER })
  declare authorId: number;

  @BelongsTo(() => Category)
  category: Category;

  @BelongsTo(() => User)
  author: User;
}
