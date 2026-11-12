import { SubscribersController } from './subscribers.controller';
import { SubscribersService } from './subscribers.service';
import { Subscriber } from './models/subscriber.model';
import { SequelizeModule } from '@nestjs/sequelize';
import { Module } from '@nestjs/common';
import { AnalyticsModule } from 'src/analytics/analytics.module';

@Module({
  imports: [SequelizeModule.forFeature([Subscriber]), AnalyticsModule],
  providers: [SubscribersService],
  controllers: [SubscribersController],
  exports: [SubscribersService],
})
export class SubscribersModule {}
