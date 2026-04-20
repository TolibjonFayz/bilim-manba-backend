import { Article } from 'src/articles/models/article.model';
import { LikesController } from './likes.controller';
import { SequelizeModule } from '@nestjs/sequelize';
import { LikesService } from './likes.service';
import { Like } from './models/like.model';
import { Module } from '@nestjs/common';

@Module({
  imports: [SequelizeModule.forFeature([Like, Article])],
  providers: [LikesService],
  controllers: [LikesController],
  exports: [LikesService],
})
export class LikesModule {}
