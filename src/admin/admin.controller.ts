import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFile,
  Query,
  StreamableFile,
  Header,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminService } from './admin.service';
import { DraftsService } from '../drafts/drafts.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private adminService: AdminService,
    private drafts: DraftsService,
  ) {}

  // Dashboard statistika
  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  // Barcha userlar
  @Get('users')
  getUsers() {
    return this.adminService.getUsers();
  }

  // Barcha maqolalar
  @Get('articles')
  getArticles() {
    return this.adminService.getArticles();
  }

  // Maqola qo'shish
  @Post('articles')
  createArticle(@Body() dto: any) {
    return this.adminService.createArticle(dto);
  }

  // Maqola yangilash
  @Put('articles/:id')
  updateArticle(@Param('id') id: string, @Body() dto: any) {
    return this.adminService.updateArticle(+id, dto);
  }

  // Maqolani Telegram kanalga (qayta) yuborish
  @Post('articles/:id/telegram')
  postToTelegram(@Param('id') id: string) {
    return this.adminService.postToTelegram(+id);
  }

  // Maqolani Instagram'ga (qayta) yuborish: post + story
  @Post('articles/:id/instagram')
  postToInstagram(@Param('id') id: string) {
    return this.adminService.postToInstagram(+id);
  }

  // Instagram kartochkasini oldindan ko'rish: ?format=feed | story
  @Get('articles/:id/social-preview')
  @Header('Content-Type', 'image/jpeg')
  @Header('Cache-Control', 'no-store')
  async socialPreview(
    @Param('id') id: string,
    @Query('format') format?: string,
  ) {
    const jpeg = await this.adminService.socialPreview(
      +id,
      format === 'story' ? 'story' : 'feed',
    );
    return new StreamableFile(jpeg);
  }

  // Avtomatik nashr holati: Telegram sozlanganmi, keyingi rejalashtirilgan vaqt
  @Get('publishing/status')
  publishingStatus() {
    return this.adminService.publishingStatus();
  }

  // AI qoralama: mavzu yoki Wikipedia havolasi bo'yicha (bo'sh — bugungi tanlangan maqola)
  @Post('drafts/generate')
  generateDraft(
    @Request() req: any,
    @Body() body: { topic?: string; categoryId?: number },
  ) {
    return this.drafts.generate({
      topic: body?.topic,
      categoryId: body?.categoryId ? +body.categoryId : undefined,
      authorId: req.user?.userId,
    });
  }

  // Kunlik AI qoralama sozlamalari va mavzular navbati
  @Get('drafts/settings')
  draftSettings() {
    return this.drafts.getSettings();
  }

  @Put('drafts/settings')
  updateDraftSettings(@Body() body: { daily?: boolean; topics?: string[] }) {
    return this.drafts.updateSettings(body);
  }

  // Maqola o'chirish
  @Delete('articles/:id')
  deleteArticle(@Param('id') id: string) {
    return this.adminService.deleteArticle(+id);
  }

  // Barcha kategoriyalar
  @Get('categories')
  getCategories() {
    return this.adminService.getCategories();
  }

  // Kategoriya qo'shish
  @Post('categories')
  createCategory(@Body() dto: any) {
    return this.adminService.createCategory(dto);
  }

  // Kategoriya yangilash
  @Put('categories/:id')
  updateCategory(@Param('id') id: string, @Body() dto: any) {
    return this.adminService.updateCategory(+id, dto);
  }

  // Kategoriya o'chirish
  @Delete('categories/:id')
  deleteCategory(@Param('id') id: string) {
    return this.adminService.deleteCategory(+id);
  }

  @Post('upload/image')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    return this.adminService.uploadImage(file);
  }

  // Content upload
  @Post('upload/content')
  uploadContent(@Body() body: { text: string; filename: string }) {
    return this.adminService.uploadContent(body.text, body.filename);
  }

  // Maqola olish
  @Get('articles/:id')
  getArticle(@Param('id') id: string) {
    return this.adminService.getArticle(+id);
  }
}
