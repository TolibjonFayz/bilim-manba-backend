import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
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
}
