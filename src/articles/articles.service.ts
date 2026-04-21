import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { CreateArticleDto } from './dto/create-article.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { Category } from 'src/categories/models/category.model';
import { Article, ArticleStatus, ArticleType } from './models/article.model';
import { User } from 'src/users/models/user.model';
import { LikesService } from 'src/likes/likes.service';
import { ArticleView } from 'src/article-views/models/article-view.model';

@Injectable()
export class ArticlesService {
  constructor(
    @InjectModel(Article) private articleModel: typeof Article,
    @InjectModel(ArticleView) private articleViewModel: typeof ArticleView,
    private likesService: LikesService,
  ) {}

  // Faqat published maqolalar — oddiy userlar uchun
  findAll(categorySlug?: string) {
    return this.articleModel.findAll({
      where: { status: ArticleStatus.PUBLISHED },
      // Content'ni list'da bermаymiz — trafik tejash uchun
      attributes: { exclude: ['content'] },
      include: [
        {
          model: Category,
          // Agar categorySlug berilsa filter qilamiz
          where: categorySlug ? { slug: categorySlug } : undefined,
          attributes: ['id', 'name', 'slug', 'icon'],
        },
        {
          model: User,
          // Parolni hech qachon frontendga bermaymiz!
          attributes: ['id', 'fullName'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  }

  // Maqola slug bo'yicha qidirish
  async findBySlug(slug: string, userId?: number) {
    const article = await this.articleModel.findOne({
      where: { slug },
      include: [
        { model: Category, attributes: ['id', 'name', 'slug'] },
        { model: User, attributes: ['id', 'fullName'] },
      ],
    });

    if (!article) throw new NotFoundException('Maqola topilmadi');

    article.increment('viewCount');

    if (userId) {
      await this.articleViewModel
        .create({
          userId,
          articleId: article.id,
        } as any)
        .catch(() => {});
    }

    let isLiked = false;
    if (userId) {
      isLiked = await this.likesService.isLiked(userId, article.id);
    }

    return { ...article.toJSON(), isLiked };
  }

  // Admin: draft maqolalar ham ko'rinadi
  findAllAdmin() {
    return this.articleModel.findAll({
      include: [
        { model: Category, attributes: ['id', 'name', 'slug'] },
        { model: User, attributes: ['id', 'fullName'] },
      ],
      order: [['createdAt', 'DESC']],
    });
  }

  create(dto: CreateArticleDto, authorId: number) {
    return this.articleModel.create({ ...dto, authorId } as any);
  }

  async update(id: number, dto: UpdateArticleDto) {
    const article = await this.articleModel.findByPk(id);
    if (!article) throw new NotFoundException('Maqola topilmadi');
    return article.update(dto);
  }

  async remove(id: number) {
    const article = await this.articleModel.findByPk(id);
    if (!article) throw new NotFoundException('Maqola topilmadi');
    await article.destroy();
    return { message: "Maqola o'chirildi" };
  }
}
