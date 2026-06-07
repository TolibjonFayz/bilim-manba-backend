import {
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BookmarksService } from './bookmarks.service';

@ApiTags('Bookmarks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class BookmarksController {
  constructor(private bookmarksService: BookmarksService) {}

  @Post('articles/:id/bookmark')
  toggle(@Param('id') id: string, @Request() req: any) {
    return this.bookmarksService.toggle(req.user.userId, +id);
  }

  @Get('users/me/bookmarks')
  getUserBookmarks(@Request() req: any) {
    return this.bookmarksService.getUserBookmarks(req.user.userId);
  }
}
