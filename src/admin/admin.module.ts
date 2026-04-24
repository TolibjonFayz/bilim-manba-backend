import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer'; // 👈 qo'shildi
import { User } from '../users/models/user.model';
import { Article } from '../articles/models/article.model';
import { Category } from '../categories/models/category.model';
import { Like } from '../likes/models/like.model';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { ArticleView } from 'src/article-views/models/article-view.model';

@Module({
  imports: [
    SequelizeModule.forFeature([User, Article, Category, ArticleView, Like]),
    CloudflareModule,
    CloudinaryModule,
    MulterModule.register({ storage: memoryStorage() }),
  ],
  providers: [AdminService],
  controllers: [AdminController],
})
export class AdminModule {}
