import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SeriesService } from './series.service';

// Ochiq: o'quvchilar uchun seriyalar (faqat chop etilgan qismlar)
@ApiTags('Series')
@Controller('series')
export class SeriesController {
  constructor(private series: SeriesService) {}

  @ApiOperation({ summary: "Seriyalar ro'yxati" })
  @Get('all')
  findAll() {
    return this.series.listPublic();
  }

  @ApiOperation({ summary: 'Seriya va uning qismlari' })
  @Get('byslug/:slug')
  findOne(@Param('slug') slug: string) {
    return this.series.bySlug(slug);
  }
}
