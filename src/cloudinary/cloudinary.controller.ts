import {
  Controller,
  Post,
  Delete,
  Body,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CloudinaryService } from './cloudinary.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('Cloudinary')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('upload')
export class CloudinaryController {
  constructor(private cloudinaryService: CloudinaryService) {}

  @Post('image')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: undefined,
    }),
  )
  async uploadImage(@UploadedFile() file: Express.Multer.File) {
    const url = await this.cloudinaryService.uploadImage(file);
    return { url };
  }

  @Delete('image')
  async deleteImage(@Body() body: { imageUrl: string }) {
    await this.cloudinaryService.deleteImage(body.imageUrl);
    return { message: "Rasm o'chirildi" };
  }
}
