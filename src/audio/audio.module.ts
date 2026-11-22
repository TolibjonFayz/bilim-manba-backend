import { Module } from '@nestjs/common';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { PublishingModule } from '../publishing/publishing.module';
import { AudioController } from './audio.controller';
import { AudioService } from './audio.service';

@Module({
  imports: [CloudflareModule, PublishingModule],
  providers: [AudioService],
  controllers: [AudioController],
  exports: [AudioService],
})
export class AudioModule {}
