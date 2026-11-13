import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail({}, { message: "Email manzil noto'g'ri" })
  @MaxLength(254)
  email: string;
}

export class ResetPasswordDto {
  // 32 bayt hex — boshqa ko'rinishdagi qiymat bazaga yetib bormaydi
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: "Havola noto'g'ri yoki muddati o'tgan" })
  token: string;

  @IsString()
  @MinLength(6, { message: "Parol kamida 6 belgidan iborat bo'lsin" })
  @MaxLength(128)
  newPassword: string;
}
