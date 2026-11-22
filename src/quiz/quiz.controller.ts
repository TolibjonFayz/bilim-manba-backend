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
import { RateLimit } from '../common/rate-limit';

const PERIODS: Period[] = ['week', 'month', 'all'];

// Test ballari reytingi: ochiq; token bo'lsa — o'z o'rni ham qaytadi
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
    @Body() body: { i?: number; choice?: number },
    @Request() req: any,
  ) {
    return this.quiz.check(
      slug,
      Number(body?.i),
      Number(body?.choice),
      req.user?.userId,
    );
  }

  // Mehmon sifatida yechilgan test — ro'yxatdan o'tgach bir marta ballga
  @ApiOperation({ summary: 'Mehmon natijasini yangi akkauntga saqlash' })
  @ApiBearerAuth()
  @RateLimit(10, 60)
  @UseGuards(JwtAuthGuard)
  @Post('claim')
  claim(
    @Body() body: { slug?: string; answers?: number[] },
    @Request() req: any,
  ) {
    return this.quiz.claim(
      req.user.userId,
      String(body?.slug ?? ''),
      body?.answers,
    );
  }

  @ApiOperation({ summary: 'Test ballari reytingi: week | month | all' })
  @UseGuards(OptionalJwtGuard)
  @Get('leaderboard')
  leaderboard(@Query('period') period: string, @Request() req: any) {
    const p = PERIODS.includes(period as Period) ? (period as Period) : 'week';
    return this.points.leaderboard(p, req.user?.userId);
  }

  @ApiOperation({ summary: 'Mening ballarim (profil): umumiy, hafta, oy' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Request() req: any) {
    return this.points.summary(req.user.userId);
  }
}
