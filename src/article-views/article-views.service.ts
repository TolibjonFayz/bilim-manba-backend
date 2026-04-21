import { Injectable } from '@nestjs/common';
import { CreateArticleViewDto } from './dto/create-article-view.dto';
import { UpdateArticleViewDto } from './dto/update-article-view.dto';

@Injectable()
export class ArticleViewsService {
  create(createArticleViewDto: CreateArticleViewDto) {
    return 'This action adds a new articleView';
  }

  findAll() {
    return `This action returns all articleViews`;
  }

  findOne(id: number) {
    return `This action returns a #${id} articleView`;
  }

  update(id: number, updateArticleViewDto: UpdateArticleViewDto) {
    return `This action updates a #${id} articleView`;
  }

  remove(id: number) {
    return `This action removes a #${id} articleView`;
  }
}
