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
  title: string;

  // SEO uchun unique URL: /articles/javascript-nima
  @Column({ type: DataType.STRING, unique: true, allowNull: false })
  slug: string;

  // Kartada ko'rinadigan qisqa tavsif
  @Column({ type: DataType.TEXT, allowNull: true })
  excerpt: string;

  // Asosiy kontent — Markdown formatida saqlanadi
  @Column({ type: DataType.TEXT, allowNull: false })
  content: string;

  // Cloudinary URL — keyinroq qo'shamiz
  @Column({ type: DataType.STRING, allowNull: true })
  coverImage: string;

  @Column({
    type: DataType.STRING,
  })
  type: ArticleType;

  @Column({
    type: DataType.STRING,
  })
  status: ArticleStatus;

  // Statistika uchun
  @Column({ type: DataType.INTEGER, defaultValue: 0 })
  viewCount: number;

  // Meilisearch tag'lari: ["javascript", "frontend"]
  @Column({ type: DataType.STRING })
  tags: string;

  @ForeignKey(() => Category)
  @Column({ type: DataType.INTEGER, allowNull: false })
  categoryId: number;

  @BelongsTo(() => Category)
  category: Category;

  // Kim yozdi
  @ForeignKey(() => User)
  @Column({ type: DataType.INTEGER, allowNull: false })
  authorId: number;

  @BelongsTo(() => User)
  author: User;
}
