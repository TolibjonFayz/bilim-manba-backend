import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { Article } from './models/article.model';
import { LikesModule } from 'src/likes/likes.module';

@Module({
  imports: [SequelizeModule.forFeature([Article]), LikesModule],
  providers: [ArticlesService],
  controllers: [ArticlesController],
})
export class ArticlesModule {}
