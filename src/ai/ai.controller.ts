import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { OptionalJwtGuard } from '../auth/guards/optional-jwt.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AiService } from './ai.service';

import { clientIp } from '../common/client-ip';
import { RateLimit } from '../common/rate-limit';

@ApiTags('AI')
@ApiBearerAuth()
@UseGuards(OptionalJwtGuard)
@Controller('ai')
export class AiController {
  constructor(private aiService: AiService) {}

  // Admin panel: maqola matnidan qisqa tavsif yozish
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('excerpt')
  excerpt(@Body() body: { title: string; text: string }) {
    return this.aiService.generateExcerpt(body.title, body.text);
  }

  // Mehmonlar — kuniga 3 ta savol (IP bo'yicha); login qilganlar — amalda
  // cheksiz (kuniga 100 ta: bitta akkaunt AI limitini yeb qo'ymasin)
  @RateLimit(20, 60, "Juda tez so'rayapsiz. Bir daqiqadan so'ng urinib ko'ring.")
  @Post('explain')
  async explain(
    @Body() body: { text: string; question: string; history?: any[] },
    @Request() req: any,
  ) {
    if (
      typeof body?.question !== 'string' ||
      !body.question.trim() ||
      (body.text !== undefined && typeof body.text !== 'string')
    ) {
      throw new BadRequestException('Savol kiritilmagan');
    }
    const ip = req.user ? null : clientIp(req);
    if (req.user) this.aiService.consumeUserQuota(req.user.userId);
    const guestRemaining =
      ip === null ? undefined : this.aiService.consumeGuestQuota(ip);

    try {
      const res = await this.aiService.explain(
        body.text,
        body.question,
        body.history ?? [],
      );
      return { ...res, guestRemaining };
    } catch (err) {
      if (ip !== null) this.aiService.refundGuestQuota(ip);
      throw err;
    }
  }
}
