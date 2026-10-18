import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Article } from '../articles/models/article.model';
import { QuizService } from './quiz.service';
import { QuizPointsService } from './quiz-points.service';
import { QuizController } from './quiz.controller';

@Module({
  imports: [SequelizeModule.forFeature([Article])],
  providers: [QuizService, QuizPointsService],
  controllers: [QuizController],
  exports: [QuizService, QuizPointsService],
})
export class QuizModule {}
