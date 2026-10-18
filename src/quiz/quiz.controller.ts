import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/guards/optional-jwt.guard';
import { Period, QuizPointsService } from './quiz-points.service';

const PERIODS: Period[] = ['week', 'month', 'all'];

// Test ballari reytingi: ochiq; token bo'lsa — o'z o'rni ham qaytadi
@ApiTags('Quiz')
@Controller('quiz')
export class QuizController {
  constructor(private points: QuizPointsService) {}

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
