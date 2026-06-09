import { Column, DataType, Model, Table } from 'sequelize-typescript';

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
}

export enum SubscriptionPlan {
  FREE = 'free',
  PREMIUM = 'premium',
}

@Table({ tableName: 'users', timestamps: true })
export class User extends Model {
  @Column({ type: DataType.STRING, allowNull: false })
  declare fullName: string;

  @Column({ type: DataType.STRING, unique: true, allowNull: false })
  declare email: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare password: string;

  @Column({
    type: DataType.ENUM(...Object.values(UserRole)),
    defaultValue: UserRole.USER,
  })
  declare role: UserRole;

  @Column({
    type: DataType.ENUM(...Object.values(SubscriptionPlan)),
    defaultValue: SubscriptionPlan.FREE,
  })
  declare plan: SubscriptionPlan;

  @Column({ type: DataType.DATE, allowNull: true })
  declare premiumExpiresAt: Date | null;

  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare isActive: boolean;

  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  declare isPublic: boolean;

  @Column({ type: DataType.STRING, allowNull: true })
  declare resetToken: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare resetTokenExpires: Date;
}
