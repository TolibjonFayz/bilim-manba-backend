import { Controller, Get, Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SchoolService } from './school.service';

// Ochiq: /maktab sahifasi uchun maqolalar
@ApiTags('School')
@Controller('school')
export class SchoolController {
  constructor(private school: SchoolService) {}

  @ApiOperation({ summary: "Maktab o'quvchilari uchun maqolalar" })
  @Get('all')
  findAll() {
    return this.school.listPublic();
  }
}

@Module({
  providers: [SchoolService],
  controllers: [SchoolController],
  exports: [SchoolService],
})
export class SchoolModule {}
