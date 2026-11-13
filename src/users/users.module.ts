import { ArticleView } from 'src/article-views/models/article-view.model';
import { Article } from 'src/articles/models/article.model';
import { UsersController } from './users.controller';
import { SequelizeModule } from '@nestjs/sequelize';
import { Like } from 'src/likes/models/like.model';
import { UsersService } from './users.service';
import { User } from './models/user.model';
import { Module } from '@nestjs/common';
import { Bookmark } from 'src/bookmarks/models/bookmark.model';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    SequelizeModule.forFeature([User, ArticleView, Like, Article, Bookmark]),
    // Parol o'zgarganda joriy qurilmaga yangi token beriladi (auth bilan bir xil kalit)
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN') },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService, SequelizeModule],
})
export class UsersModule {}
