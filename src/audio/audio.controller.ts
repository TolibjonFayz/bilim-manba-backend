import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AudioService } from './audio.service';

// Ochiq: podkast lentasi (bilimmanba.uz/podcast.xml) va /audio sahifasi
@ApiTags('Audio')
@Controller('audio')
export class AudioController {
  constructor(private readonly audio: AudioService) {}

  @ApiOperation({ summary: 'Audiosi bor maqolalar (eng yangisi birinchi)' })
  @Get('feed')
  feed() {
    return this.audio.feed();
  }
}
