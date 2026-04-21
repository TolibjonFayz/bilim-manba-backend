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

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard) // 👈 qo'shildi
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @ApiOperation({ summary: 'Get user information by ID' })
  @Get('one/:id')
  getOne(@Param('id') id: number) {
    return this.usersService.findById(id);
  }

  @ApiOperation({ summary: 'Update user information' })
  @Put('one/:id')
  updateMe(@Param('id') id: number, @Body() dto: UpdateUserDto) {
    return this.usersService.updateMe(id, dto);
  }

  @ApiOperation({ summary: 'Update user password' })
  @Put('password/:id')
  updatePassword(@Param('id') id: number, @Body() dto: UpdatePasswordDto) {
    return this.usersService.updatePassword(id, dto);
  }

  @ApiOperation({ summary: 'Get user statistics' })
  @Get('me/stats')
  getStats(@Request() req: any) {
    return this.usersService.getStats(req.user.userId);
  }

  @ApiOperation({ summary: 'Get user recent reads' })
  @Get('me/recent-reads')
  getRecentReads(@Request() req: any) {
    return this.usersService.getRecentReads(req.user.userId);
  }

  @ApiOperation({ summary: 'Get user weekly activity' })
  @Get('me/weekly-activity')
  getWeeklyActivity(@Request() req: any) {
    return this.usersService.getWeeklyActivity(req.user.userId);
  }
}
