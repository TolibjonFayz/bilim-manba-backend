import { ApiProperty } from '@nestjs/swagger';
import { IsNumber } from 'class-validator';

export class CreateLikeDto {
  @ApiProperty({
    example: 1,
    description: 'ID of the user who likes the article',
  })
  @IsNumber()
  userId: number;

  @ApiProperty({
    example: 1,
    description: 'ID of the article being liked',
  })
  @IsNumber()
  articleId: number;
}
