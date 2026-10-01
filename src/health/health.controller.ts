import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Sequelize } from 'sequelize-typescript';

/**
 * Uptime monitoring (UptimeRobot) uchun tekshiruv manzillari.
 *
 * Ikkiga ajratilgan: Neon bepul tarifida baza 5 daqiqa ishlatilmasa uxlaydi
 * va hisoblash soatlari cheklangan. /health bazaga tegmaydi — uni har 5
 * daqiqada tekshirish mumkin (Render'ni ham uyg'oq ushlaydi). /health/db
 * bazani ham tekshiradi — uni kamroq (masalan soatiga bir) tekshirish kerak.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  @ApiOperation({ summary: 'Backend tirikmi (bazaga tegmaydi)' })
  @Get()
  @Header('Cache-Control', 'no-store')
  live() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  @ApiOperation({ summary: 'Backend va baza ishlayaptimi' })
  @Get('db')
  @Header('Cache-Control', 'no-store')
  async db() {
    const started = Date.now();
    try {
      // Neon uxlab qolgan bo'lsa uyg'onishi ~1-3 soniya oladi
      await Promise.race([
        this.sequelize.query('SELECT 1'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 15000),
        ),
      ]);
      return { status: 'ok', db: 'ok', ms: Date.now() - started };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
  }
}
