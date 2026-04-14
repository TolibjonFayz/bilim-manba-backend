import { CloudinaryController } from './cloudinary.controller';
import { CloudinaryService } from './cloudinary.service';
import { Module } from '@nestjs/common';

@Module({
  providers: [CloudinaryService],
  controllers: [CloudinaryController],
  exports: [CloudinaryService],
})
export class CloudinaryModule {}
