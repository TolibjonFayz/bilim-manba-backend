import { UsersController } from './users.controller';
import { SequelizeModule } from '@nestjs/sequelize';
import { UsersService } from './users.service';
import { User } from './models/user.model';
import { Module } from '@nestjs/common';

@Module({
  imports: [SequelizeModule.forFeature([User])],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService, SequelizeModule],
})
export class UsersModule {}
