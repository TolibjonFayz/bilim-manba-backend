import { Injectable, NotFoundException } from '@nestjs/common';
import { Article } from 'src/articles/models/article.model';
import { InjectModel } from '@nestjs/sequelize';
import { Like } from './models/like.model';

@Injectable()
export class LikesService {
  constructor(
    @InjectModel(Like) private likeModel: typeof Like,
    @InjectModel(Article) private articleModel: typeof Article,
  ) {}

  // Toggle like — agar bor bo'lsa o'chir, yo'q bo'lsa qo'sh
  async toggle(userId: number, articleId: number) {
    const article = await this.articleModel.findByPk(articleId);
    if (!article) throw new NotFoundException('Maqola topilmadi');

    // User shu maqolani like qilganmi?
    const existing = await this.likeModel.findOne({
      where: { userId, articleId },
    });

    if (existing) {
      // Unlike — o'chiramiz
      await existing.destroy();
      // likeCount ni kamaytiramiz (cache)
      await article.decrement('likeCount');
      return {
        isLiked: false,
        likeCount: article.likeCount - 1,
      };
    } else {
      // Like — qo'shamiz
      await this.likeModel.create({ userId, articleId } as any);
      await article.increment('likeCount');
      return {
        isLiked: true,
        likeCount: article.likeCount + 1,
      };
    }
  }

  // User shu maqolani like qilganmi tekshirish
  async isLiked(userId: number, articleId: number): Promise<boolean> {
    const like = await this.likeModel.findOne({
      where: { userId, articleId },
    });
    return !!like;
  }

  // User barcha like qilgan maqolalar
  async getUserLikes(userId: number) {
    const likes = await this.likeModel.findAll({
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
            'type',
            'viewCount',
            'likeCount',
          ],
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    return likes;
  }
}
