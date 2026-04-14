import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';

@Injectable()
export class CloudinaryService {
  constructor(private config: ConfigService) {
    cloudinary.config({
      cloud_name: this.config.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.config.get('CLOUDINARY_API_KEY'),
      api_secret: this.config.get('CLOUDINARY_API_SECRET'),
    });
  }

  async uploadImage(file: Express.Multer.File): Promise<string> {
    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Faqat rasm fayllari qabul qilinadi');
    }

    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException("Rasm 5MB dan katta bo'lmasin");
    }

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'bilim-manba/articles',
          transformation: [
            { width: 1200, height: 630, crop: 'fill' },
            { quality: 'auto' },
            { fetch_format: 'auto' },
          ],
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result!.secure_url);
        },
      );

      uploadStream.end(file.buffer);
    });
  }

  async deleteImage(imageUrl: string): Promise<void> {
    const parts = imageUrl.split('/');
    const filename = parts[parts.length - 1].split('.')[0];
    const folder = parts[parts.length - 2];
    const publicId = `${folder}/${filename}`;

    await cloudinary.uploader.destroy(publicId);
  }
}
