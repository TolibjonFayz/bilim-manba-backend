import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { text } from 'express';
import { applyHttpSecurity } from './common/http-security';

async function bootstrap() {
  const PORT = process.env.PORT || 3333;
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');
  app.setGlobalPrefix('api');

  // CORS (faqat o'z saytimiz) va xavfsizlik sarlavhalari
  applyHttpSecurity(app);

  // Statistika hodisalari text/plain bilan keladi (sendBeacon, preflight'siz)
  app.use('/api/t', text({ type: 'text/plain', limit: '100kb' }));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // API hujjati (Swagger) hamma endpointlarni ko'rsatib qo'yadi — odatda
  // yopiq. Kerak bo'lsa: env SWAGGER=on
  if (process.env.SWAGGER === 'on') {
    const config = new DocumentBuilder()
      .setTitle('Bilim Manba API')
      .setDescription('Bilim Manba backend API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('/api/docs', app, document);
  }

  const secret = process.env.JWT_SECRET ?? '';
  if (secret.length < 32) {
    logger.warn(
      'JWT_SECRET juda qisqa (32 belgidan kam) — uni uzun tasodifiy qatorga almashtiring, aks holda token soxtalashtirilishi mumkin!',
    );
  }

  await app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}
bootstrap();
