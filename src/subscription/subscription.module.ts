import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { User } from 'src/users/models/user.model';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';

@Module({
  imports: [SequelizeModule.forFeature([User])],
  providers: [SubscriptionService],
  controllers: [SubscriptionController],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
