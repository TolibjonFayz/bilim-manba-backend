import { Module } from '@nestjs/common';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { AudioService } from './audio.service';

@Module({
  imports: [CloudflareModule],
  providers: [AudioService],
  exports: [AudioService],
})
export class AudioModule {}
