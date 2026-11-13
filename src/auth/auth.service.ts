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
import { AnalyticsService } from 'src/analytics/analytics.service';
import { takeToken, tooMany } from '../common/rate-limit';

// Mavjud bo'lmagan email uchun ham parol solishtiriladi — javob vaqti
// bo'yicha "bu email ro'yxatda bor/yo'q" ni bilib bo'lmasin
const DUMMY_HASH = bcrypt.hashSync('bilim-manba-dummy-password', 10);

/** Tiklash kodi bazada ochiq saqlanmaydi — faqat xeshi */
const hashToken = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private mailerService: MailerService,
    private analytics: AnalyticsService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing)
      throw new BadRequestException("Bu email allaqachon ro'yxatdan o'tgan");

    const { signupSource, signupPath, ...fields } = dto;
    const hashed = await bcrypt.hash(fields.password, 10);
    const user = await this.usersService.create({
      ...fields,
      fullName: fields.fullName.trim(),
      password: hashed,
    });
    await this.analytics.markSignup('users', user.id, signupSource, signupPath);

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
    // Bitta akkauntga turli IP lardan parol terib ko'rishga qarshi
    const emailKey = `login-email:${dto.email.trim().toLowerCase()}`;
    if (!takeToken(emailKey, 15, 15 * 60 * 1000)) {
      tooMany("Juda ko'p kirish urinishi. 15 daqiqadan so'ng urinib ko'ring.");
    }

    const user = await this.usersService.findByEmail(dto.email);
    const match = await bcrypt.compare(
      dto.password,
      user?.dataValues.password ?? DUMMY_HASH,
    );
    if (!user || !match)
      throw new UnauthorizedException("Email yoki parol noto'g'ri");
    if (user.dataValues.isActive === false)
      throw new UnauthorizedException('Akkaunt bloklangan');

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
    const message = "Agar email mavjud bo'lsa, xat yuborildi";
    // Bitta emailga ketma-ket xat yuborib bezovta qilishga qarshi
    if (!takeToken(`forgot:${email.trim().toLowerCase()}`, 3, 60 * 60 * 1000)) {
      return { message };
    }

    const user = await this.usersService.findByEmail(email);
    if (!user) return { message };

    // Random token — 32 byte hex; bazaga faqat xeshi yoziladi
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 soat

    await user.update({
      resetToken: hashToken(token),
      resetTokenExpires: expires,
    });

    const site = (process.env.SITE_URL ?? 'https://bilimmanba.uz').replace(
      /\/$/,
      '',
    );
    const resetUrl = `${site}/reset-password?token=${token}`;
    // Kutmaymiz: javob vaqti email bor-yo'qligini oshkor qilmasin
    void this.mailerService.sendResetPasswordEmail(
      user.dataValues.email,
      user.dataValues.fullName ?? email,
      resetUrl,
    );

    return { message };
  }

  // 2. Reset password
  async resetPassword(token: string, newPassword: string) {
    const user = await this.usersService.findByResetToken(hashToken(token));
    if (!user) {
      throw new BadRequestException("Havola noto'g'ri yoki muddati o'tgan");
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.usersService.updateResetToken(user.id, null, null, hashed);

    return { message: 'Parol muvaffaqiyatli yangilandi' };
  }
}
