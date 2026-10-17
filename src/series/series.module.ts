import { Module } from '@nestjs/common';
import { SeriesController } from './series.controller';
import { SeriesService } from './series.service';

@Module({
  providers: [SeriesService],
  controllers: [SeriesController],
  exports: [SeriesService],
})
export class SeriesModule {}
