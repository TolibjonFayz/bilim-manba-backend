import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  Table,
} from 'sequelize-typescript';
import { Article } from 'src/articles/models/article.model';
import { User } from 'src/users/models/user.model';

@Table({ tableName: 'comments', timestamps: true })
export class Comment extends Model {
  @Column({ type: DataType.TEXT, allowNull: false })
  content: string;

  @ForeignKey(() => User)
  @Column({ type: DataType.INTEGER, allowNull: false })
  userId: number;

  @BelongsTo(() => User)
  user: User;

  @ForeignKey(() => Article)
  @Column({ type: DataType.INTEGER, allowNull: false })
  articleId: number;

  @BelongsTo(() => Article)
  article: Article;

  // Javob bo'lsa — parent comment id (top-level bo'lsa null)
  @ForeignKey(() => Comment)
  @Column({ type: DataType.INTEGER, allowNull: true })
  parentId: number | null;

  @HasMany(() => Comment, 'parentId')
  replies: Comment[];
}
