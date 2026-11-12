import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'John Doe', description: 'Full name of the user' })
  @IsString()
  fullName: string;

  @ApiProperty({
    example: 'john.doe@example.com',
    description: 'Email address of the user',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'password123',
    description: 'Password for the user account',
  })
  @IsString()
  @MinLength(6)
  password: string;

  // Statistika: qaysi forma va qaysi sahifadan ro'yxatdan o'tdi
  @IsOptional()
  @IsString()
  @MaxLength(60)
  signupSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  signupPath?: string;
}
