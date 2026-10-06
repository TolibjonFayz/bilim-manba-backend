import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { Article } from '../articles/models/article.model';
import { Category } from '../categories/models/category.model';
import { MailerModule } from '../mailer/mailer.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscribersModule } from '../subscribers/subscribers.module';
import { PublishingService } from './publishing.service';
import { TelegramService } from './telegram.service';
import { InstagramService } from './instagram.service';
import { SocialImageService } from './social-image.service';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';

@Module({
  imports: [
    SequelizeModule.forFeature([Article, Category]),
    MailerModule,
    NotificationsModule,
    SubscribersModule,
    CloudinaryModule,
  ],
  providers: [
    PublishingService,
    TelegramService,
    InstagramService,
    SocialImageService,
  ],
  exports: [PublishingService, TelegramService, InstagramService],
})
export class PublishingModule {}
