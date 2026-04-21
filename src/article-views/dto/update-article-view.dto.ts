import { PartialType } from '@nestjs/swagger';
import { CreateArticleViewDto } from './create-article-view.dto';

export class UpdateArticleViewDto extends PartialType(CreateArticleViewDto) {}
