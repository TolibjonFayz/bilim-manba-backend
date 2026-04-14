import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SequelizeModule } from '@nestjs/sequelize';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CategoriesModule } from './categories/categories.module';
import { ArticlesModule } from './articles/articles.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { AiModule } from './ai/ai.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { PaymentModule } from './payment/payment.module';
import { User } from './users/models/user.model';

@Module({
  imports: [
    ConfigModule.forRoot({ envFilePath: '.env', isGlobal: true }),
    SequelizeModule.forRoot({
      dialect: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      username: process.env.POSTGRES_USER,
      password: String(process.env.POSTGRES_PASSWORD),
      database: process.env.POSTGRES_DB,
      autoLoadModels: true,
      logging: false,
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      },
      models: [User],
    }),

    AuthModule,
    UsersModule,
    CategoriesModule,
    ArticlesModule,
    SubscriptionModule,
    AiModule,
    CloudinaryModule,
    PaymentModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
