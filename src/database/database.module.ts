import { Module } from '@nestjs/common';
import { DataMigrationsService } from './data-migrations.service';

@Module({
  providers: [DataMigrationsService],
})
export class DatabaseModule {}
