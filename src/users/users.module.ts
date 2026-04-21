import { ArticleView } from 'src/article-views/models/article-view.model';
import { Article } from 'src/articles/models/article.model';
import { UsersController } from './users.controller';
import { SequelizeModule } from '@nestjs/sequelize';
import { Like } from 'src/likes/models/like.model';
import { UsersService } from './users.service';
import { User } from './models/user.model';
import { Module } from '@nestjs/common';

@Module({
  imports: [SequelizeModule.forFeature([User, ArticleView, Like, Article])],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService, SequelizeModule],
})
export class UsersModule {}
