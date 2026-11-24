import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/guards/optional-jwt.guard';
import { Period, QuizPointsService } from './quiz-points.service';
import { QuizService } from './quiz.service';
import { isGuestId } from './quiz-guests';
import { RateLimit } from '../common/rate-limit';

const PERIODS: Period[] = ['week', 'month', 'all'];

// Test ballari reytingi: ochiq; token bo'lsa — o'z o'rni ham qaytadi
// Mehmon ID: brauzer yaratgan UUID (bo'lmasa yoki noto'g'ri bo'lsa — e'tiborsiz)
const guestOf = (v: unknown) => (isGuestId(v) ? v.toLowerCase() : undefined);

@ApiTags('Quiz')
@Controller('quiz')
export class QuizController {
  constructor(
    private points: QuizPointsService,
    private quiz: QuizService,
  ) {}

  // Bitta savol javobini tekshiradi (to'g'ri javob sahifaga oldindan berilmaydi).
  // Token bo'lsa — birinchi tanlov yoziladi, ball shundan hisoblanadi
  @ApiOperation({ summary: 'Test savoliga javobni tekshirish' })
  @RateLimit(60, 60)
  @UseGuards(OptionalJwtGuard)
  @Post('check/:slug')
  check(
    @Param('slug') slug: string,
    @Body() body: { i?: number; choice?: number; guest?: string },
    @Request() req: any,
  ) {
    const userId = req.user?.userId;
    return this.quiz.check(
      slug,
      Number(body?.i),
      Number(body?.choice),
      userId ? { userId } : { guestId: guestOf(body?.guest) },
    );
  }

  // Mehmon kirdi/ro'yxatdan o'tdi: uning ballari akkauntga ko'chiriladi
  @ApiOperation({ summary: "Mehmon ballarini akkauntga ko'chirish" })
  @ApiBearerAuth()
  @RateLimit(10, 60)
  @UseGuards(JwtAuthGuard)
  @Post('merge')
  merge(@Body() body: { guest?: string }, @Request() req: any) {
    const guestId = guestOf(body?.guest);
    if (!guestId) return { merged: 0, points: 0 };
    return this.points.merge(req.user.userId, guestId);
  }

  @ApiOperation({ summary: 'Test ballari reytingi: week | month | all' })
  @UseGuards(OptionalJwtGuard)
  @Get('leaderboard')
  leaderboard(
    @Query('period') period: string,
    @Query('guest') guest: string,
    @Request() req: any,
  ) {
    const p = PERIODS.includes(period as Period) ? (period as Period) : 'week';
    const userId = req.user?.userId;
    return this.points.leaderboard(
      p,
      userId ? { userId } : { guestId: guestOf(guest) },
    );
  }

  @ApiOperation({ summary: 'Mening ballarim (profil): umumiy, hafta, oy' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Request() req: any) {
    return this.points.summary(req.user.userId);
  }
}
