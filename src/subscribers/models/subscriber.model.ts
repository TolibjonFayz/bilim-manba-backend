import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({ tableName: 'subscribers', timestamps: true })
export class Subscriber extends Model {
  @Column({ type: DataType.STRING, allowNull: false, unique: true })
  declare email: string;

  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare isActive: boolean;
}
