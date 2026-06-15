import { Module } from '@nestjs/common';
import { Article } from './models/article.model';
import { SequelizeModule } from '@nestjs/sequelize';
import { ArticlesService } from './articles.service';
import { LikesModule } from 'src/likes/likes.module';
import { ArticlesController } from './articles.controller';
import { Category } from 'src/categories/models/category.model';
import { BookmarksModule } from 'src/bookmarks/bookmarks.module';
import { ArticleView } from 'src/article-views/models/article-view.model';
import { ArticleViewsModule } from 'src/article-views/article-views.module';

@Module({
  imports: [
    SequelizeModule.forFeature([Article, ArticleView, Category]),
    LikesModule,
    ArticleViewsModule,
    BookmarksModule,
  ],
  providers: [ArticlesService],
  controllers: [ArticlesController],
})
export class ArticlesModule {}
