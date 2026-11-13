import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Comment } from './models/comment.model';
import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';
import { Article } from 'src/articles/models/article.model';

@Module({
  imports: [SequelizeModule.forFeature([Comment, Article])],
  providers: [CommentsService],
  controllers: [CommentsController],
  exports: [CommentsService],
})
export class CommentsModule {}
