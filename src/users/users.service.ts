import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { UpdateUserDto, UpdatePasswordDto } from './dto/update-user.dto';
import { User } from './models/user.model';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User) private userModel: typeof User) {}

  //Create user
  async create(data: Partial<User>) {
    return await this.userModel.create(data as any);
  }

  //Get user by email
  async findByEmail(email: string) {
    return await this.userModel.findOne({ where: { email } });
  }

  //Get user by id
  async findById(id: number) {
    const user = await this.userModel.findByPk(id, {
      attributes: [
        'id',
        'fullName',
        'email',
        'role',
        'plan',
        'premiumExpiresAt',
        'createdAt',
      ],
    });
    if (!user) throw new NotFoundException('User topilmadi');
    return user;
  }

  // Profilni yangilash
  async updateMe(userId: number, dto: UpdateUserDto) {
    const user = await this.userModel.findByPk(userId);
    if (!user) throw new NotFoundException('User topilmadi');
    await user.update(dto);
    return await this.findById(userId);
  }

  // Parolni o'zgartirish
  async updatePassword(userId: number, dto: UpdatePasswordDto) {
    const user = await this.userModel.findByPk(userId);

    if (!user) throw new NotFoundException('User topilmadi');

    const match = await bcrypt.compare(
      dto.currentPassword,
      user.dataValues.password,
    );
    if (!match) throw new BadRequestException("Joriy parol noto'g'ri");

    const hashed = await bcrypt.hash(dto.newPassword, 10);
    await user.update({ password: hashed });
    return { message: "Parol muvaffaqiyatli o'zgartirildi" };
  }
}
