import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Article } from '../articles/models/article.model';
import { Category } from '../categories/models/category.model';
import { User } from '../users/models/user.model';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { DraftsService } from './drafts.service';

@Module({
  imports: [
    SequelizeModule.forFeature([Article, Category, User]),
    CloudflareModule,
  ],
  providers: [DraftsService],
  exports: [DraftsService],
})
export class DraftsModule {}
