import { ArticleView } from './models/article-view.model';
import { SequelizeModule } from '@nestjs/sequelize';
import { Module } from '@nestjs/common';

@Module({
  imports: [SequelizeModule.forFeature([ArticleView])],
  exports: [SequelizeModule],
})
export class ArticleViewsModule {}
