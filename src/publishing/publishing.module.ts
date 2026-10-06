import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Article } from '../articles/models/article.model';
import { Category } from '../categories/models/category.model';
import { MailerModule } from '../mailer/mailer.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscribersModule } from '../subscribers/subscribers.module';
import { PublishingService } from './publishing.service';
import { TelegramService } from './telegram.service';

@Module({
  imports: [
    SequelizeModule.forFeature([Article, Category]),
    MailerModule,
    NotificationsModule,
    SubscribersModule,
  ],
  providers: [PublishingService, TelegramService],
  exports: [PublishingService, TelegramService],
})
export class PublishingModule {}
