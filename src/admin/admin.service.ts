import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { User } from '../users/models/user.model';
import { Like } from '../likes/models/like.model';
import { Article } from '../articles/models/article.model';
import { Category } from '../categories/models/category.model';
import { ArticleView } from 'src/article-views/models/article-view.model';
import { CloudflareService } from 'src/cloudflare/cloudflare.service';
import { CloudinaryService } from 'src/cloudinary/cloudinary.service';

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(Article) private articleModel: typeof Article,
    @InjectModel(Category) private categoryModel: typeof Category,
    @InjectModel(ArticleView) private articleViewModel: typeof ArticleView,
    @InjectModel(Like) private likeModel: typeof Like,
    private cloudflareService: CloudflareService,
    private cloudinaryService: CloudinaryService,
  ) {}

  // Dashboard statistika
  async getStats() {
    const [userCount, articleCount, viewCount, likeCount] = await Promise.all([
      this.userModel.count(),
      this.articleModel.count(),
      this.articleViewModel.count(),
      this.likeModel.count(),
    ]);

    return { userCount, articleCount, viewCount, likeCount };
  }

  // Barcha userlar
  async getUsers() {
    return this.userModel.findAll({
      attributes: ['id', 'fullName', 'email', 'role', 'plan', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });
  }

  // Barcha maqolalar
  async getArticles() {
    return this.articleModel.findAll({
      include: [
        { model: Category, attributes: ['id', 'name', 'slug'] },
        { model: User, attributes: ['id', 'fullName'] },
      ],
      order: [['createdAt', 'DESC']],
    });
  }

  // Maqola qo'shish
  async createArticle(dto: any) {
    return this.articleModel.create(dto);
  }

  // Maqola yangilash
  async updateArticle(id: number, dto: any) {
    await this.articleModel.update(dto, { where: { id } });
    return this.articleModel.findByPk(id);
  }

  // Maqola o'chirish
  async deleteArticle(id: number) {
    // Avval bog'liq jadvallarni o'chiramiz
    await this.articleViewModel.destroy({ where: { articleId: id } });
    await this.likeModel.destroy({ where: { articleId: id } });
    // Keyin maqolani o'chiramiz
    await this.articleModel.destroy({ where: { id } });
    return { message: "Maqola o'chirildi" };
  }

  // Barcha kategoriyalar
  async getCategories() {
    return this.categoryModel.findAll({
      order: [['createdAt', 'DESC']],
    });
  }

  // Kategoriya qo'shish
  async createCategory(dto: any) {
    return this.categoryModel.create(dto);
  }

  // Kategoriya yangilash
  async updateCategory(id: number, dto: any) {
    await this.categoryModel.update(dto, { where: { id } });
    return this.categoryModel.findByPk(id);
  }

  // Kategoriya o'chirish
  async deleteCategory(id: number) {
    await this.categoryModel.destroy({ where: { id } });
    return { message: "Kategoriya o'chirildi" };
  }

  // Methodlar:
  async uploadImage(file: Express.Multer.File) {
    const url = await this.cloudinaryService.uploadImage(file);
    return { url };
  }

  async uploadContent(text: string, filename: string) {
    const url = await this.cloudflareService.uploadJson(
      { message: text },
      `${filename}-${Date.now()}.json`,
    );
    return { url };
  }

  async getArticle(id: number) {
    return this.articleModel.findByPk(id, {
      include: [
        { model: Category, attributes: ['id', 'name', 'slug'] },
        { model: User, attributes: ['id', 'fullName'] },
      ],
    });
  }
}
