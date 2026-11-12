import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { text } from 'express';

async function bootstrap() {
  const PORT = process.env.PORT || 3333;
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  // Statistika hodisalari text/plain bilan keladi (sendBeacon, preflight'siz)
  app.use('/api/t', text({ type: 'text/plain', limit: '100kb' }));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({
    origin: '*',
    methods: 'GET,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Authorization',
    credentials: true,
    optionsSuccessStatus: 200,
  });

  const config = new DocumentBuilder()
    .setTitle('Bilim Manba API')
    .setDescription('Bilim Manba backend API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('/api/docs', app, document);

  await app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}
bootstrap();
