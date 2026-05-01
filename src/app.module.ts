import { ArticleViewsModule } from './article-views/article-views.module';
import { ArticleView } from './article-views/models/article-view.model';
import { SubscriptionModule } from './subscription/subscription.module';
import { SubscribersModule } from './subscribers/subscribers.module';
import { CategoriesModule } from './categories/categories.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { CloudflareModule } from './cloudflare/cloudflare.module';
import { Category } from './categories/models/category.model';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ArticlesModule } from './articles/articles.module';
import { Article } from './articles/models/article.model';
import { PaymentModule } from './payment/payment.module';
import { MailerModule } from './mailer/mailer.module';
import { SequelizeModule } from '@nestjs/sequelize';
import { UsersModule } from './users/users.module';
import { LikesModule } from './likes/likes.module';
import { AdminModule } from './admin/admin.module';
import { User } from './users/models/user.model';
import { Like } from './likes/models/like.model';
import { AuthModule } from './auth/auth.module';
import { AiModule } from './ai/ai.module';
import { Module } from '@nestjs/common';

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
      synchronize: true,
      logging: false,
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      },
      models: [User, Category, Article, Like, ArticleView],
    }),

    AuthModule,
    UsersModule,
    CategoriesModule,
    ArticlesModule,
    SubscriptionModule,
    AiModule,
    CloudinaryModule,
    PaymentModule,
    LikesModule,
    ArticleViewsModule,
    AdminModule,
    CloudflareModule,
    SubscribersModule,
    MailerModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
