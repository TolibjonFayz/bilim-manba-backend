import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Bookmark } from './models/bookmark.model';
import { Article } from 'src/articles/models/article.model';
import { BookmarksService } from './bookmarks.service';
import { BookmarksController } from './bookmarks.controller';

@Module({
  imports: [SequelizeModule.forFeature([Bookmark, Article])],
  providers: [BookmarksService],
  controllers: [BookmarksController],
  exports: [BookmarksService],
})
export class BookmarksModule {}
