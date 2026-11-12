import { Controller, Post, Body, Get, Query } from '@nestjs/common';
import { SubscribersService } from './subscribers.service';

@Controller('subscribers')
export class SubscribersController {
  constructor(private subscribersService: SubscribersService) {}

  @Post('subscribe')
  // source — qaysi forma (masalan, "newsletter_footer"), path — qaysi sahifada
  subscribe(@Body() body: { email: string; source?: string; path?: string }) {
    return this.subscribersService.subscribe(body.email, body.source, body.path);
  }

  @Get('unsubscribe')
  unsubscribe(@Query('email') email: string) {
    return this.subscribersService.unsubscribe(email);
  }
}
