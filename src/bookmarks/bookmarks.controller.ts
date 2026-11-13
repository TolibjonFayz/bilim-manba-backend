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
import { BookmarksService } from './bookmarks.service';

@ApiTags('Bookmarks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class BookmarksController {
  constructor(private bookmarksService: BookmarksService) {}

  @RateLimit(60, 60)
  @Post('articles/:id/bookmark')
  toggle(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.bookmarksService.toggle(req.user.userId, id);
  }

  @Get('users/me/bookmarks')
  getUserBookmarks(@Request() req: any) {
    return this.bookmarksService.getUserBookmarks(req.user.userId);
  }
}
