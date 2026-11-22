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
import { verifyGoogleIdToken } from './google-token';
import { GoogleLoginDto } from './dto/google-login.dto';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { MailArticle } from 'src/mailer/mailer.service';
import {
  checkVerifyToken,
  parseVerifyToken,
  verifyEmailUrl,
} from '../common/verify-token';

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
    private config: ConfigService,
    @InjectConnection() private sequelize: Sequelize,
  ) {}

  /** Xush kelibsiz xati uchun: eng ko'p o'qilgan 3 ta maqola */
  private async popular(limit = 3): Promise<MailArticle[]> {
    try {
      return await this.sequelize.query<MailArticle>(
        `SELECT a.title, a.slug, a.excerpt, a."coverImage", c.name AS category
         FROM articles a LEFT JOIN categories c ON c.id = a."categoryId"
         WHERE a.status = 'published'
         ORDER BY a."viewCount" DESC LIMIT :limit`,
        { replacements: { limit }, type: QueryTypes.SELECT },
      );
    } catch {
      return [];
    }
  }

  /** Ro'yxatdan o'tgach xat: kutmaymiz — javob tez qaytsin, xato saytni to'xtatmasin */
  private welcome(
    user: { id: number; email: string; fullName: string },
    verify: boolean,
  ) {
    void (async () => {
      const url = verify ? verifyEmailUrl(user.id, user.email) : null;
      await this.mailerService.sendWelcomeEmail(
        user.email,
        user.fullName,
        url,
        await this.popular(),
      );
    })().catch(() => {});
  }

  /** Emailni tasdiqlash havolasi (xatdan) */
  async verifyEmail(token: string) {
    const t = parseVerifyToken(token);
    const user = t ? await this.usersService.findRawById(t.userId) : null;
    if (!user || !checkVerifyToken(token, user.dataValues.email)) {
      throw new BadRequestException(
        "Havola noto'g'ri yoki muddati o'tgan. Profilingizdan yangi xat so'rang.",
      );
    }
    if (!user.dataValues.emailVerifiedAt) {
      await user.update({ emailVerifiedAt: new Date() });
    }
    return { ok: true, message: 'Email tasdiqlandi' };
  }

  /** Tasdiqlash xatini qayta yuborish (profildan) */
  async resendVerification(userId: number) {
    const user = await this.usersService.findRawById(userId);
    if (!user) throw new BadRequestException('Foydalanuvchi topilmadi');
    if (user.dataValues.emailVerifiedAt) return { ok: true, already: true };
    const sent = await this.mailerService.sendWelcomeEmail(
      user.dataValues.email,
      user.dataValues.fullName,
      verifyEmailUrl(user.id, user.dataValues.email),
      [],
    );
    if (!sent)
      throw new BadRequestException("Xat yuborilmadi, keyinroq urinib ko'ring");
    return { ok: true };
  }

  private get googleClientId() {
    return (this.config.get<string>('GOOGLE_CLIENT_ID') ?? '').trim();
  }

  googleConfig() {
    return {
      enabled: Boolean(this.googleClientId),
      clientId: this.googleClientId || null,
    };
  }

  /**
   * Google ID token tekshiriladi; shu email bilan akkaunt bo'lsa — kiradi,
   * bo'lmasa yangi akkaunt ochiladi (parolsiz: tasodifiy parol xeshi, xohlasa
   * "Parolni unutdingizmi" orqali parol qo'yadi).
   */
  async google(dto: GoogleLoginDto) {
    if (!this.googleClientId) {
      throw new BadRequestException('Google bilan kirish hali yoqilmagan');
    }
    let profile;
    try {
      profile = await verifyGoogleIdToken(dto.credential, this.googleClientId);
    } catch (err: any) {
      throw new UnauthorizedException(
        `Google orqali kirib bo'lmadi: ${err?.message ?? 'xato'}`,
      );
    }

    let user = await this.usersService.findByEmailInsensitive(profile.email);
    let isNew = false;
    if (!user) {
      const random = crypto.randomBytes(32).toString('hex');
      user = await this.usersService.create({
        fullName: (profile.name || profile.email.split('@')[0]).slice(0, 80),
        email: profile.email,
        password: await bcrypt.hash(random, 10),
      });
      isNew = true;
      // Google emailni o'zi tasdiqlagan
      await user.update({ emailVerifiedAt: new Date() });
      this.welcome(
        {
          id: user.id,
          email: user.dataValues.email,
          fullName: user.dataValues.fullName,
        },
        false,
      );
      await this.analytics.markSignup(
        'users',
        user.id,
        dto.signupSource ?? 'google',
        dto.signupPath,
      );
    }
    if (user.dataValues.isActive === false) {
      throw new UnauthorizedException('Akkaunt bloklangan');
    }
    if (!isNew && !user.dataValues.emailVerifiedAt) {
      await user.update({ emailVerifiedAt: new Date() });
    }
    return {
      userId: user.id,
      isNew,
      token: this.signToken(
        user.id,
        user.dataValues.email,
        user.dataValues.role,
        user.dataValues.plan,
      ),
    };
  }

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
    this.welcome(
      {
        id: user.id,
        email: user.dataValues.email,
        fullName: user.dataValues.fullName,
      },
      true,
    );

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
