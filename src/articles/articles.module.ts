import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { Article } from './models/article.model';

@Module({
  imports: [SequelizeModule.forFeature([Article])],
  providers: [ArticlesService],
  controllers: [ArticlesController],
})
export class ArticlesModule {}
