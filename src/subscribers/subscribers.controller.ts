import { Controller, Post, Body, Get, Query } from '@nestjs/common';
import { SubscribersService } from './subscribers.service';
import { SubscribeDto, UnsubscribeDto } from './dto/create-subscriber.dto';
import { RateLimit } from '../common/rate-limit';

@Controller('subscribers')
export class SubscribersController {
  constructor(private subscribersService: SubscribersService) {}

  // source — qaysi forma (masalan, "newsletter_footer"), path — qaysi sahifada
  @RateLimit(10, 3600, "Juda ko'p urinish. Keyinroq urinib ko'ring.")
  @Post('subscribe')
  subscribe(@Body() dto: SubscribeDto) {
    return this.subscribersService.subscribe(dto.email, dto.source, dto.path);
  }

  // Xatdagi havola: email + imzo (token). Imzosiz hech kimning obunasi
  // o'chirilmaydi — avval emailni bilgan har kim o'chira olardi.
  @RateLimit(30, 3600)
  @Get('unsubscribe')
  unsubscribe(@Query() dto: UnsubscribeDto) {
    return this.subscribersService.unsubscribe(dto.email, dto.token);
  }

  // Pochta dasturlaridagi "Unsubscribe" tugmasi (List-Unsubscribe-Post)
  @RateLimit(30, 3600)
  @Post('unsubscribe')
  unsubscribeOneClick(@Query() dto: UnsubscribeDto) {
    return this.subscribersService.unsubscribe(dto.email, dto.token);
  }
}
