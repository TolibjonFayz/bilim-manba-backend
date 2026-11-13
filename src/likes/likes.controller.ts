import {
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  Request,
  ParseIntPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimit } from '../common/rate-limit';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LikesService } from './likes.service';

@ApiTags('Likes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard) // Barcha endpoint login talab qiladi
@Controller()
export class LikesController {
  constructor(private likesService: LikesService) {}

  // Toggle like
  @RateLimit(60, 60)
  @Post('articles/:id/like')
  toggle(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.likesService.toggle(req.user.userId, id);
  }

  // User like qilgan maqolalar (profilda "Saqlangan" tab uchun)
  @Get('users/me/likes')
  getUserLikes(@Request() req: any) {
    return this.likesService.getUserLikes(req.user.userId);
  }
}
