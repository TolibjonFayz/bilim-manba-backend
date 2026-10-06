import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { CreateCategoryDto } from './dto/create-category.dto';
import { Category } from './models/category.model';
import { Article, ArticleStatus } from '../articles/models/article.model';

// Kategoriya bilan faqat chop etilgan maqolalar — qoralamalar sanalmasin va ko'rinmasin
const PUBLISHED_ARTICLES = {
  model: Article,
  where: { status: ArticleStatus.PUBLISHED },
  required: false,
};

@Injectable()
export class CategoriesService {
  constructor(@InjectModel(Category) private categoryModel: typeof Category) {}

  // Hamma kategoriyalar — sidebar, navbar uchun
  async findAll() {
    return await this.categoryModel.findAll({
      order: [['id', 'ASC']],
      include: [PUBLISHED_ARTICLES],
    });
  }

  // Find category by slug
  async findBySlug(slug: string) {
    const category = await this.categoryModel.findOne({
      where: { name: slug },
      include: [PUBLISHED_ARTICLES],
    });
    if (!category) throw new NotFoundException('Kategoriya topilmadi');
    return category;
  }

  // Create category
  async create(dto: CreateCategoryDto) {
    const exists = await this.categoryModel.findOne({
      where: { slug: dto.slug },
    });
    if (exists) throw new ConflictException('Bu slug allaqachon mavjud');
    return this.categoryModel.create(dto as any);
  }

  // Update category
  async update(id: number, dto: Partial<CreateCategoryDto>) {
    const category = await this.categoryModel.findByPk(id);
    if (!category) throw new NotFoundException('Kategoriya topilmadi');
    return category.update(dto);
  }

  // Delete category
  async remove(id: number) {
    const category = await this.categoryModel.findByPk(id);
    if (!category) throw new NotFoundException('Kategoriya topilmadi');
    await category.destroy();
    return { message: "Kategoriya o'chirildi" };
  }
}
