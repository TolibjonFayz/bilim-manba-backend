import { Column, DataType, HasMany, Model, Table } from 'sequelize-typescript';
import { Article } from 'src/articles/models/article.model';

@Table({ tableName: 'categories', timestamps: true })
export class Category extends Model {
  @Column({ type: DataType.STRING, allowNull: false })
  name: string;

  @Column({ type: DataType.STRING, unique: true, allowNull: false })
  slug: string;

  @Column({ type: DataType.STRING, allowNull: true })
  icon: string;

  @HasMany(() => Article)
  articles: Article[];
}
