import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { OptionalJwtGuard } from '../auth/guards/optional-jwt.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AiService } from './ai.service';

// Render Cloudflare ortida turadi — req.ip proxy manzilini beradi,
// shuning uchun haqiqiy mijoz IP sini headerlardan olamiz
function clientIp(req: any): string {
  const h = req.headers ?? {};
  const xff = String(h['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    h['cf-connecting-ip'] ??
    h['true-client-ip'] ??
    xff[xff.length - 1] ??
    req.ip ??
    'unknown'
  );
}

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

  // Login qilganlar — cheksiz; mehmonlar — kuniga 3 ta savol (IP bo'yicha)
  @Post('explain')
  async explain(
    @Body() body: { text: string; question: string; history?: any[] },
    @Request() req: any,
  ) {
    const ip = req.user ? null : clientIp(req);
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
