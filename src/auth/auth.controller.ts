import {
  Body,
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RateLimit } from '../common/rate-limit';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @ApiOperation({ summary: 'Register a new user' })
  @RateLimit(
    20,
    3600,
    "Juda ko'p ro'yxatdan o'tish urinishi. Keyinroq urinib ko'ring.",
  )
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  // Parol terib ko'rishga qarshi: IP bo'yicha shu yerda, email bo'yicha servisda
  @ApiOperation({ summary: 'Login and get access token' })
  @RateLimit(
    20,
    300,
    "Juda ko'p kirish urinishi. 5 daqiqadan so'ng urinib ko'ring.",
  )
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @ApiOperation({ summary: 'Get current user information' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req) {
    return req.user;
  }

  @RateLimit(5, 900, "Juda ko'p so'rov. 15 daqiqadan so'ng urinib ko'ring.")
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @RateLimit(10, 900)
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.newPassword);
  }
}
