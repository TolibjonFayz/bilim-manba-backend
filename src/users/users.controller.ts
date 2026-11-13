import {
  Controller,
  Get,
  Put,
  Body,
  Request,
  UseGuards,
  Param,
  ForbiddenException,
  ParseIntPipe,
} from '@nestjs/common';
import { UpdateUserDto, UpdatePasswordDto } from './dto/update-user.dto';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { RateLimit } from '../common/rate-limit';

@ApiBearerAuth()
@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  /**
   * Manzildagi :id faqat o'ziniki bo'lishi shart. Avval tekshirilmasdi —
   * kirgan har qanday foydalanuvchi boshqa birovning emailini ko'ra,
   * ismini o'zgartira va parolini terib ko'ra olardi.
   */
  private ownOnly(req: any, id: number) {
    if (req.user?.userId !== id) {
      throw new ForbiddenException("Faqat o'z profilingiz bilan ishlay olasiz");
    }
  }

  // 👇 PUBLIC — guard yo'q
  @ApiOperation({ summary: 'Get public profile' })
  @Get('public/:id')
  getPublicProfile(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.getPublicProfile(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('one/:id')
  getOne(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    this.ownOnly(req, id);
    return this.usersService.findById(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Put('one/:id')
  updateMe(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @Request() req: any,
  ) {
    this.ownOnly(req, id);
    return this.usersService.updateMe(id, dto);
  }

  @ApiBearerAuth()
  @RateLimit(10, 900, "Juda ko'p urinish. 15 daqiqadan so'ng urinib ko'ring.")
  @UseGuards(JwtAuthGuard)
  @Put('password/:id')
  updatePassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePasswordDto,
    @Request() req: any,
  ) {
    this.ownOnly(req, id);
    return this.usersService.updatePassword(id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me/stats')
  getStats(@Request() req: any) {
    return this.usersService.getStats(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me/recent-reads')
  getRecentReads(@Request() req: any) {
    return this.usersService.getRecentReads(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me/weekly-activity')
  getWeeklyActivity(@Request() req: any) {
    return this.usersService.getWeeklyActivity(req.user.userId);
  }
}
