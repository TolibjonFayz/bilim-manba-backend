import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Article } from '../articles/models/article.model';
import { Category } from '../categories/models/category.model';
import { User } from '../users/models/user.model';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { PublishingModule } from '../publishing/publishing.module';
import { DraftsService } from './drafts.service';
import { SearchConsoleService } from '../search-console/search-console.service';

@Module({
  imports: [
    SequelizeModule.forFeature([Article, Category, User]),
    CloudflareModule,
    CloudinaryModule,
    PublishingModule,
  ],
  // Search Console shu yerda — AI mavzu tanlashda qidiruv talabidan foydalanadi
  providers: [DraftsService, SearchConsoleService],
  exports: [DraftsService, SearchConsoleService],
})
export class DraftsModule {}
