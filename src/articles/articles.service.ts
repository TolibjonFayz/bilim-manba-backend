import { Article, ArticleStatus, ArticleType } from './models/article.model';
import { QuizService } from 'src/quiz/quiz.service';
import { SeriesService } from 'src/series/series.service';
import { ArticleView } from 'src/article-views/models/article-view.model';
import { BookmarksService } from 'src/bookmarks/bookmarks.service';
import { Category } from 'src/categories/models/category.model';
import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateArticleDto } from './dto/create-article.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { LikesService } from 'src/likes/likes.service';
import { User } from 'src/users/models/user.model';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';

@Injectable()
export class ArticlesService {
  constructor(
    @InjectModel(Article) private articleModel: typeof Article,
    @InjectModel(ArticleView) private articleViewModel: typeof ArticleView,
    @InjectModel(Category) private categoryModel: typeof Category,
    private likesService: LikesService,
    private bookmarksService: BookmarksService,
    private quiz: QuizService,
    private series: SeriesService,
  ) {}

  // Faqat published maqolalar — oddiy userlar uchun
  findAll(categorySlug?: string) {
    return this.articleModel.findAll({
      where: { status: ArticleStatus.PUBLISHED },
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
          attributes: ['id', 'fullName'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  }

  quizResult(slug: string, correct: number) {
    return this.quiz.recordResult(slug, correct);
  }

  // Maqola slug bo'yicha qidirish
  async findBySlug(slug: string, userId?: number) {
    // Faqat chop etilgan — qoralamalar (AI yozgan, rejalashtirilgan) ochiq emas
    const article = await this.articleModel.findOne({
      where: { slug, status: ArticleStatus.PUBLISHED },
      include: [
        { model: Category, attributes: ['id', 'name', 'slug'] },
        { model: User, attributes: ['id', 'fullName'] },
      ],
    });

    if (!article) throw new NotFoundException('Maqola topilmadi');

    let isLiked = false;
    if (userId) {
      isLiked = await this.likesService.isLiked(userId, article.id);
    }

    let isBookmarked = false;
    if (userId) {
      isBookmarked = await this.bookmarksService.isBookmarked(
        userId,
        article.id,
      );
    }

    // Maqola oxiridagi test va seriya (bo'lmasa null) — alohida jadvallardan
    const [quiz, series] = await Promise.all([
      this.quiz.forArticle(article.id),
      this.series.forArticle(article.id),
    ]);

    return { ...article.toJSON(), isLiked, isBookmarked, quiz, series };
  }

  async recordView(slug: string, userId?: number) {
    const article = await this.articleModel.findOne({
      where: { slug, status: ArticleStatus.PUBLISHED },
    });
    if (!article) return { success: false };

    await article.increment('viewCount');
    // Kunlik hisobot uchun (Toshkent sanasi bo'yicha)
    await this.articleModel.sequelize
      ?.query(
        `INSERT INTO daily_views ("articleId", day, views)
         VALUES (:id, ((now() AT TIME ZONE 'UTC') + interval '5 hours')::date, 1)
         ON CONFLICT ("articleId", day) DO UPDATE SET views = daily_views.views + 1`,
        { replacements: { id: article.id } },
      )
      .catch(() => {});

    if (userId) {
      await this.articleViewModel
        .create({ userId, articleId: article.id } as any)
        .catch(() => {});
    }

    return { success: true };
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

  async search(query: string) {
    if (!query || query.trim().length < 2) {
      return [];
    }

    const q = `%${query.trim()}%`;

    return this.articleModel.findAll({
      where: {
        status: ArticleStatus.PUBLISHED,
        [Op.or]: [
          { title: { [Op.iLike]: q } },
          { excerpt: { [Op.iLike]: q } },
          { source: { [Op.iLike]: q } },
          { tags: { [Op.iLike]: q } },
        ],
      },
      attributes: { exclude: ['content'] },
      include: [
        { model: Category, attributes: ['id', 'name', 'slug', 'icon'] },
        { model: User, attributes: ['id', 'fullName'] },
      ],
      order: [['viewCount', 'DESC']],
      limit: 20,
    });
  }

  async getSitemapData() {
    const articles = await this.articleModel.findAll({
      where: { status: 'published' },
      attributes: ['slug', 'updatedAt'],
      order: [['updatedAt', 'DESC']],
    });

    const categories = await this.categoryModel.findAll({
      attributes: ['slug', 'updatedAt'],
    });

    const series = await this.series.sitemap();

    return { articles, categories, series };
  }
}
