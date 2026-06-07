import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Article } from 'src/articles/models/article.model';
import { Bookmark } from './models/bookmark.model';

@Injectable()
export class BookmarksService {
  constructor(
    @InjectModel(Bookmark) private bookmarkModel: typeof Bookmark,
    @InjectModel(Article) private articleModel: typeof Article,
  ) {}

  async toggle(userId: number, articleId: number) {
    const article = await this.articleModel.findByPk(articleId);
    if (!article) throw new NotFoundException('Maqola topilmadi');

    const existing = await this.bookmarkModel.findOne({
      where: { userId, articleId },
    });

    if (existing) {
      await existing.destroy();
      return { isBookmarked: false };
    } else {
      await this.bookmarkModel.create({ userId, articleId } as any);
      return { isBookmarked: true };
    }
  }

  async isBookmarked(userId: number, articleId: number): Promise<boolean> {
    const bm = await this.bookmarkModel.findOne({
      where: { userId, articleId },
    });
    return !!bm;
  }

  async getUserBookmarks(userId: number) {
    return this.bookmarkModel.findAll({
      where: { userId },
      include: [
        {
          model: Article,
          attributes: [
            'id',
            'title',
            'slug',
            'excerpt',
            'coverImage',
            'viewCount',
            'likeCount',
          ],
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  }
}
