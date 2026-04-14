import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { CreateArticleDto } from './dto/create-article.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { Category } from 'src/categories/models/category.model';
import { Article, ArticleStatus, ArticleType } from './models/article.model';
import { User } from 'src/users/models/user.model';

@Injectable()
export class ArticlesService {
  constructor(@InjectModel(Article) private articleModel: typeof Article) {}

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

  async findBySlug(slug: string, userPlan: string = 'free') {
    const article = await this.articleModel.findOne({
      where: { slug, status: ArticleStatus.PUBLISHED },
      include: [
        { model: Category, attributes: ['id', 'name', 'slug'] },
        { model: User, attributes: ['id', 'fullName'] },
      ],
    });

    if (!article) throw new NotFoundException('Maqola topilmadi');

    if (article.type === ArticleType.PREMIUM && userPlan !== 'premium') {
      const { content, ...rest } = article.toJSON();
      return { ...rest, content: null, locked: true };
    }

    article.increment('viewCount');

    return article;
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
