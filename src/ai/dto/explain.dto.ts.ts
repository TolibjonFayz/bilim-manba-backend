import { IsString, MinLength, MaxLength } from 'class-validator';

export class ExplainDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  text: string;

  @IsString()
  @MaxLength(300)
  question: string;
}
