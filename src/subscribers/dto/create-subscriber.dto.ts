import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSubscriberDto {}

export class SubscribeDto {
  @IsEmail({}, { message: "Email manzil noto'g'ri" })
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  path?: string;
}

export class UnsubscribeDto {
  @IsEmail({}, { message: "Email manzil noto'g'ri" })
  @MaxLength(254)
  email: string;

  @IsString()
  @MaxLength(100)
  token: string;
}
