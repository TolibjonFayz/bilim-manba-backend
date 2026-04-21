import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ArticleViewsService } from './article-views.service';
import { CreateArticleViewDto } from './dto/create-article-view.dto';
import { UpdateArticleViewDto } from './dto/update-article-view.dto';

@Controller('article-views')
export class ArticleViewsController {
  constructor(private readonly articleViewsService: ArticleViewsService) {}

  @Post()
  create(@Body() createArticleViewDto: CreateArticleViewDto) {
    return this.articleViewsService.create(createArticleViewDto);
  }

  @Get()
  findAll() {
    return this.articleViewsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.articleViewsService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateArticleViewDto: UpdateArticleViewDto) {
    return this.articleViewsService.update(+id, updateArticleViewDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.articleViewsService.remove(+id);
  }
}
