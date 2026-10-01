import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { ArticleStatus, ArticleType } from '../models/article.model';
import { ApiProperty } from '@nestjs/swagger';

export class CreateArticleDto {
  @ApiProperty({ example: 'Technology', description: 'Name of the article' })
  @IsString()
  title: string;

  @ApiProperty({ example: 'technology', description: 'Slug of the article' })
  @IsString()
  slug: string;

  @ApiProperty({
    example: "Kvant fizikasining eng g'alati g'oyasi oddiy tilda.",
    description: 'Short summary (card, meta description)',
  })
  @IsOptional()
  @IsString()
  excerpt?: string;

  @ApiProperty({
    example: 'Quanta Magazine (Ben Brubaker)',
    description: 'Original source / author of the article',
  })
  @IsOptional()
  @IsString()
  source?: string;

  @ApiProperty({
    example: 'This is the content of the article',
    description: 'Content of the article',
  })
  @IsString()
  content: string;

  @ApiProperty({
    example: 'https://example.com/cover.jpg',
    description: 'Cover image of the article',
  })
  @IsOptional()
  @IsString()
  coverImage?: string;

  @ApiProperty({ example: 'Technology', description: 'Type of the article' })
  @IsEnum(ArticleType)
  type: ArticleType;

  @ApiProperty({ example: 'active', description: 'Status of the article' })
  @IsOptional()
  @IsEnum(ArticleStatus)
  status?: ArticleStatus;

  @ApiProperty({
    example: 'sport, health, knowledge',
    description: 'Comma-separated list of tags for the article',
  })
  @IsOptional()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ example: 1, description: 'ID of the category' })
  @IsNumber()
  categoryId: number;
}
