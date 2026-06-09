import {
  Controller,
  Get,
  Put,
  Body,
  Request,
  UseGuards,
  Param,
} from '@nestjs/common';
import { UpdateUserDto, UpdatePasswordDto } from './dto/update-user.dto';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';

@ApiBearerAuth()
@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  // 👇 PUBLIC — guard yo'q
  @ApiOperation({ summary: 'Get public profile' })
  @Get('public/:id')
  getPublicProfile(@Param('id') id: number) {
    return this.usersService.getPublicProfile(id);
  }

  // 👇 Pastdagi hammasiga alohida guard qo'shamiz
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('one/:id')
  getOne(@Param('id') id: number) {
    return this.usersService.findById(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Put('one/:id')
  updateMe(@Param('id') id: number, @Body() dto: UpdateUserDto) {
    return this.usersService.updateMe(id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Put('password/:id')
  updatePassword(@Param('id') id: number, @Body() dto: UpdatePasswordDto) {
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
