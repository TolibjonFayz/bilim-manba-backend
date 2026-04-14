import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateCategoryDto {
  @ApiProperty({
    example: 'Technology',
    description: 'Name of the category',
  })
  @IsString()
  name: string;

  @ApiProperty({
    example: 'technology',
    description: 'Slug of the category',
  })
  @IsString()
  slug: string;

  @ApiProperty({
    example: 'technology.png',
    description: 'Icon of the category',
  })
  @IsOptional()
  @IsString()
  icon?: string;
}
