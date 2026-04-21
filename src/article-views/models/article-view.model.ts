import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from 'sequelize-typescript';
import { Article } from 'src/articles/models/article.model';
import { User } from 'src/users/models/user.model';

@Table({ tableName: 'article_views', timestamps: true })
export class ArticleView extends Model {
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

  // O'qish vaqti (soniyalarda) — opsional
  @Column({ type: DataType.INTEGER, defaultValue: 0 })
  readDuration: number;
}
