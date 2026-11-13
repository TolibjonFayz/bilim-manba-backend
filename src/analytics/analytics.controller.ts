import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { RateLimit } from '../common/rate-limit';

@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * Brauzerdagi kuzatuvchi (plugins/analytics.client.ts) hodisalarni shu yerga
   * yuboradi. text/plain — CORS "preflight" so'rovisiz va sahifa yopilayotganda
   * ham (sendBeacon) yetib borishi uchun. Hech qachon xato qaytarmaydi.
   */
  @ApiExcludeEndpoint()
  @RateLimit(120, 60)
  @Post('t')
  @HttpCode(200)
  async track(@Body() body: unknown, @Req() req: any) {
    let data: any = body;
    if (typeof body === 'string') {
      try {
        data = JSON.parse(body);
      } catch {
        return { ok: false };
      }
    }
    try {
      return await this.analytics.ingest(data, {
        ua: String(req.headers?.['user-agent'] ?? ''),
        country: req.headers?.['cf-ipcountry'] ?? null,
      });
    } catch {
      return { ok: false };
    }
  }
}
