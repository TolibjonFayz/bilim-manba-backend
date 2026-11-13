import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Comment } from './models/comment.model';
import { User } from 'src/users/models/user.model';
import { Article, ArticleStatus } from 'src/articles/models/article.model';
import { CreateCommentDto } from './dto/create-comment.dto';

@Injectable()
export class CommentsService {
  constructor(
    @InjectModel(Comment) private commentModel: typeof Comment,
    @InjectModel(Article) private articleModel: typeof Article,
  ) {}

  // Maqola izohlari — nested (top-level + replies)
  async findByArticle(articleId: number) {
    if (!Number.isInteger(articleId) || articleId <= 0) return [];
    const comments = await this.commentModel.findAll({
      where: { articleId, parentId: null },
      include: [
        { model: User, attributes: ['id', 'fullName', 'role'] },
        {
          model: Comment,
          as: 'replies',
          include: [{ model: User, attributes: ['id', 'fullName', 'role'] }],
          separate: true, // replies ni alohida sortlash uchun
          order: [['createdAt', 'ASC']],
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    return comments;
  }

  async create(userId: number, articleId: number, dto: CreateCommentDto) {
    const content = dto.content.trim();
    if (!content) throw new BadRequestException("Izoh bo'sh bo'lmasin");

    // Faqat chop etilgan maqolaga izoh yoziladi (qoralama yoki yo'q maqolaga emas)
    const article = await this.articleModel.findOne({
      where: { id: articleId, status: ArticleStatus.PUBLISHED },
      attributes: ['id'],
    });
    if (!article) throw new NotFoundException('Maqola topilmadi');

    // Javob bo'lsa — asosiy izoh shu maqolaniki bo'lishi shart
    let parentId: number | null = null;
    if (dto.parentId) {
      const parent = await this.commentModel.findByPk(dto.parentId);
      if (!parent || parent.dataValues.articleId !== articleId) {
        throw new NotFoundException('Izoh topilmadi');
      }
      // Javobga javob — o'sha asosiy izoh ostiga (sayt bir darajani ko'rsatadi)
      parentId = parent.dataValues.parentId ?? parent.id;
    }

    const comment = await this.commentModel.create({
      content,
      userId,
      articleId,
      parentId,
    } as any);

    // User ma'lumoti bilan qaytaramiz
    return this.commentModel.findByPk(comment.id, {
      include: [{ model: User, attributes: ['id', 'fullName', 'role'] }],
    });
  }

  async delete(userId: number, userRole: string, commentId: number) {
    const comment = await this.commentModel.findByPk(commentId);
    if (!comment) throw new NotFoundException('Izoh topilmadi');

    // Faqat o'z izohini yoki admin o'chira oladi
    if (comment.dataValues.userId !== userId && userRole !== 'admin') {
      throw new ForbiddenException("Bu izohni o'chira olmaysiz");
    }

    // Reply'larni ham o'chiramiz
    await this.commentModel.destroy({ where: { parentId: commentId } });
    await comment.destroy();

    return { message: "Izoh o'chirildi" };
  }

  async countByArticle(articleId: number): Promise<number> {
    return this.commentModel.count({ where: { articleId } });
  }
}
