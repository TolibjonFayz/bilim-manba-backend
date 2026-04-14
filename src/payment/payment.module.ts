import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { User } from 'src/users/models/user.model';
import { PaymentService } from './payment.service';
import { PaymeController } from './payment.controller';

@Module({
  imports: [SequelizeModule.forFeature([User])],
  providers: [PaymentService],
  controllers: [PaymeController],
})
export class PaymentModule {}
