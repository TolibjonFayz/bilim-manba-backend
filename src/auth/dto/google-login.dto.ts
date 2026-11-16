import { IsOptional, IsString, MaxLength } from 'class-validator';

export class GoogleLoginDto {
  // Google Identity Services bergan ID token (JWT)
  @IsString()
  @MaxLength(4096)
  credential: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  signupSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  signupPath?: string;
}
