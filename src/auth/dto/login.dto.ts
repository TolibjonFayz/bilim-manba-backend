import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    example: 'john.doe@example.com',
    description: 'Email of the user',
  })
  @IsString()
  email: string;

  @ApiProperty({ example: 'password123', description: 'Password of the user' })
  @IsString()
  password: string;
}
