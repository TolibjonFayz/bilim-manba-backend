import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsInt,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateCommentDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(1000)
  content: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  parentId?: number;
}
