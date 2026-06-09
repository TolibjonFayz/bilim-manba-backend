import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from 'sequelize-typescript';
import { User } from 'src/users/models/user.model';

@Table({ tableName: 'notifications', timestamps: true })
export class Notification extends Model {
  @ForeignKey(() => User)
  @Column({ type: DataType.INTEGER, allowNull: false })
  userId: number;

  @BelongsTo(() => User)
  user: User;

  @Column({ type: DataType.STRING, allowNull: false })
  title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  message: string;

  // Bosilganda qayerga olib boradi: /articles/slug
  @Column({ type: DataType.STRING, allowNull: true })
  link: string;

  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  isRead: boolean;
}
