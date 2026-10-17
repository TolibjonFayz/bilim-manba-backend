import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Article } from '../articles/models/article.model';
import { QuizService } from './quiz.service';

@Module({
  imports: [SequelizeModule.forFeature([Article])],
  providers: [QuizService],
  exports: [QuizService],
})
export class QuizModule {}
