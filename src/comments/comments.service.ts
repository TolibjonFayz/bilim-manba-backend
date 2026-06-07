import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Comment } from './models/comment.model';
import { User } from 'src/users/models/user.model';
import { CreateCommentDto } from './dto/create-comment.dto';

@Injectable()
export class CommentsService {
  constructor(@InjectModel(Comment) private commentModel: typeof Comment) {}

  // Maqola izohlari — nested (top-level + replies)
  async findByArticle(articleId: number) {
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
    // Agar reply bo'lsa — parent mavjudligini tekshir
    if (dto.parentId) {
      const parent = await this.commentModel.findByPk(dto.parentId);
      if (!parent) throw new NotFoundException('Izoh topilmadi');
    }

    const comment = await this.commentModel.create({
      content: dto.content,
      userId,
      articleId,
      parentId: dto.parentId ?? null,
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
    if (comment.userId !== userId && userRole !== 'admin') {
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
