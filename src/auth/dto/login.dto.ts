import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    example: 'john.doe@example.com',
    description: 'Email of the user',
  })
  @IsString()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'password123', description: 'Password of the user' })
  @IsString()
  @MaxLength(128)
  password: string;
}
