import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class CloudflareService {
  private s3: S3Client;
  private bucket: string;
  private publicUrl: string;

  constructor(private config: ConfigService) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: this.config.get<string>('CF_R2_ENDPOINT'),
      credentials: {
        accessKeyId: this.config.get<string>('CF_R2_ACCESS_KEY_ID') as string,
        secretAccessKey: this.config.get<string>(
          'CF_R2_SECRET_ACCESS_KEY',
        ) as string,
      },
    });
    this.bucket = this.config.get<string>('CF_R2_BUCKET') as string;
    this.publicUrl = this.config.get<string>('CF_R2_PUBLIC_URL') as string;
  }

  get filesBaseUrl() {
    return this.publicUrl;
  }

  /** Biriktirilgan fayl (kitob, hujjat): doim yuklab olinadi, sahifa sifatida ochilmaydi */
  async uploadFile(
    body: Buffer,
    key: string,
    contentType: string,
    downloadName: string,
  ): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return `${this.publicUrl}/${key}`;
  }

  async uploadJson(content: object, filename: string): Promise<string> {
    const key = `articles/${filename}`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(content),
        ContentType: 'application/json',
      }),
    );
    return `${this.publicUrl}/${key}`;
  }
}
