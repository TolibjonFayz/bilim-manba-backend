import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { MailerService } from 'src/mailer/mailer.service';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Op } from 'sequelize';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private mailerService: MailerService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing)
      throw new BadRequestException("Bu email allaqachon ro'yxatdan o'tgan");

    const hashed = await bcrypt.hash(dto.password, 10);
    const user = await this.usersService.create({ ...dto, password: hashed });

    return {
      userId: user.id,
      token: this.signToken(
        user.id,
        user.dataValues.email,
        user.dataValues.role,
        user.dataValues.plan,
      ),
    };
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException("Email yoki parol noto'g'ri");

    const match = await bcrypt.compare(dto.password, user?.dataValues.password);
    if (!match) throw new UnauthorizedException("Email yoki parol noto'g'ri");
    return {
      userId: user.id,
      token: this.signToken(
        user.id,
        user.dataValues.email,
        user.dataValues.role,
        user.dataValues.plan,
      ),
    };
  }

  private signToken(userId: number, email: string, role: string, plan: string) {
    return {
      access_token: this.jwtService.sign({ sub: userId, email, role, plan }),
    };
  }

  async forgotPassword(email: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return { message: "Agar email mavjud bo'lsa, xat yuborildi" };
    }

    // Random token — 32 byte hex
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 soat

    // DB ga saqla
    await user.update({
      resetToken: token,
      resetTokenExpires: expires,
    });

    // Email yuvor
    const resetUrl = `https://bilimmanba.uz/reset-password?token=${token}`;
    await this.mailerService.sendResetPasswordEmail(
      email,
      user.fullName ?? email,
      resetUrl,
    );

    return { message: "Agar email mavjud bo'lsa, xat yuborildi" };
  }

  // 2. Reset password
  async resetPassword(token: string, newPassword: string) {
    // UsersService orqali topamiz
    const user = await this.usersService.findByResetToken(token);
    if (!user) {
      throw new BadRequestException("Token noto'g'ri yoki muddati o'tgan");
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.usersService.updateResetToken(user.id, null, null, hashed);

    return { message: 'Parol muvaffaqiyatli yangilandi' };
  }
}
