import { Controller, Post, Body, Get, Query } from '@nestjs/common';
import { SubscribersService } from './subscribers.service';

@Controller('subscribers')
export class SubscribersController {
  constructor(private subscribersService: SubscribersService) {}

  @Post('subscribe')
  subscribe(@Body() body: { email: string }) {
    return this.subscribersService.subscribe(body.email);
  }

  @Get('unsubscribe')
  unsubscribe(@Query('email') email: string) {
    return this.subscribersService.unsubscribe(email);
  }
}
