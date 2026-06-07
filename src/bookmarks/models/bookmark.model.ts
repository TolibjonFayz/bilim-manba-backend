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

@Table({
  tableName: 'bookmarks',
  timestamps: true,
  indexes: [{ unique: true, fields: ['userId', 'articleId'] }],
})
export class Bookmark extends Model {
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
}
