import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { Article } from './models/article.model';
import { LikesModule } from 'src/likes/likes.module';
import { ArticleView } from 'src/article-views/models/article-view.model';
import { ArticleViewsModule } from 'src/article-views/article-views.module';

@Module({
  imports: [
    SequelizeModule.forFeature([Article, ArticleView]),
    LikesModule,
    ArticleViewsModule,
  ],
  providers: [ArticlesService],
  controllers: [ArticlesController],
})
export class ArticlesModule {}
