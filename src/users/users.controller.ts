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
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
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
}
