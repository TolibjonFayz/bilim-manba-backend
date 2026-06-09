import { memoryStorage } from 'multer';
import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { Like } from '../likes/models/like.model';
import { User } from '../users/models/user.model';
import { SequelizeModule } from '@nestjs/sequelize';
import { AdminController } from './admin.controller';
import { MailerModule } from 'src/mailer/mailer.module';
import { MulterModule } from '@nestjs/platform-express';
import { Article } from '../articles/models/article.model';
import { Category } from '../categories/models/category.model';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { ArticleView } from 'src/article-views/models/article-view.model';
import { SubscribersModule } from 'src/subscribers/subscribers.module';
import { NotificationsModule } from 'src/notifications/notifications.module';

@Module({
  imports: [
    SequelizeModule.forFeature([User, Article, Category, ArticleView, Like]),
    CloudflareModule,
    CloudinaryModule,
    MulterModule.register({ storage: memoryStorage() }),
    SubscribersModule,
    MailerModule,
    NotificationsModule,
  ],
  providers: [AdminService],
  controllers: [AdminController],
})
export class AdminModule {}
