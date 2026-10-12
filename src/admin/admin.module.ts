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
import { PublishingModule } from 'src/publishing/publishing.module';
import { DraftsModule } from 'src/drafts/drafts.module';
import { StatsService } from 'src/stats/stats.service';
import { SearchConsoleService } from 'src/search-console/search-console.service';

@Module({
  imports: [
    SequelizeModule.forFeature([User, Article, Category, ArticleView, Like]),
    CloudflareModule,
    CloudinaryModule,
    MulterModule.register({ storage: memoryStorage() }),
    SubscribersModule,
    MailerModule,
    NotificationsModule,
    PublishingModule,
    DraftsModule,
  ],
  providers: [AdminService, StatsService, SearchConsoleService],
  controllers: [AdminController],
})
export class AdminModule {}
