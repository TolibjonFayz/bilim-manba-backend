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
  declare userId: number;

  @BelongsTo(() => User)
  user: User;

  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare message: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare link: string;

  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  declare isRead: boolean;
}
