import { IsNumber, IsPositive } from 'class-validator';

export class ActivatePremiumDto {
  @IsNumber()
  @IsPositive()
  months: number;
}
