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
  fullName: string;

  @Column({ type: DataType.STRING, unique: true, allowNull: false })
  email: string;

  @Column({ type: DataType.STRING, allowNull: false })
  password: string;

  @Column({
    type: DataType.ENUM(...Object.values(UserRole)),
    defaultValue: UserRole.USER,
  })
  role: UserRole;

  @Column({
    type: DataType.ENUM(...Object.values(SubscriptionPlan)),
    defaultValue: SubscriptionPlan.FREE,
  })
  plan: SubscriptionPlan;

  @Column({ type: DataType.DATE, allowNull: true })
  premiumExpiresAt: Date | null;

  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  isActive: boolean;
}
