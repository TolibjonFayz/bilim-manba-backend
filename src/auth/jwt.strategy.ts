// src/auth/jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get<string>('JWT_SECRET') as string,
      algorithms: ['HS256'],
    });
  }

  /**
   * Token imzosi to'g'ri bo'lishi yetarli emas: foydalanuvchi hali mavjudmi,
   * bloklanmaganmi va token parol o'zgarishidan keyin berilganmi — bazadan
   * tekshiriladi. Rol ham tokendan emas, bazadan olinadi (admin huquqi
   * olib tashlansa, eski token bilan admin bo'lib qolmasin).
   */
  async validate(payload: any) {
    const id = Number(payload?.sub);
    if (!Number.isInteger(id) || id <= 0) throw new UnauthorizedException();

    const user = await this.users.authState(id);
    if (!user || !user.isActive) throw new UnauthorizedException();
    if (
      user.passwordChangedAt &&
      Number(payload.iat) * 1000 < user.passwordChangedAt
    ) {
      throw new UnauthorizedException();
    }

    return {
      userId: id,
      email: user.email,
      role: user.role,
      plan: user.plan,
    };
  }
}
