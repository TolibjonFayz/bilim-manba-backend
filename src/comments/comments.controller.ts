import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { RateLimit } from '../common/rate-limit';

@ApiTags('Comments')
@Controller()
export class CommentsController {
  constructor(private commentsService: CommentsService) {}

  // Hammaga ochiq — izohlarni ko'rish
  @Get('articles/:id/comments')
  findByArticle(@Param('id', ParseIntPipe) id: number) {
    return this.commentsService.findByArticle(id);
  }

  // Login kerak — izoh qoldirish
  @ApiBearerAuth()
  @RateLimit(10, 60, "Juda tez yozyapsiz. Bir daqiqadan so'ng urinib ko'ring.")
  @UseGuards(JwtAuthGuard)
  @Post('articles/:id/comments')
  create(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateCommentDto,
    @Request() req: any,
  ) {
    return this.commentsService.create(req.user.userId, id, dto);
  }

  // Login kerak — izohni o'chirish
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Delete('comments/:id')
  delete(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.commentsService.delete(req.user.userId, req.user.role, id);
  }
}
