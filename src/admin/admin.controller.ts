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
import { Period, StatsService } from '../stats/stats.service';
import { SearchConsoleService } from '../search-console/search-console.service';
import { AdminAlertService } from '../publishing/admin-alert.service';
import { SeriesService } from '../series/series.service';
import { SchoolService } from '../school/school.service';
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
    private stats: StatsService,
    private searchConsole: SearchConsoleService,
    private alerts: AdminAlertService,
    private series: SeriesService,
    private school: SchoolService,
  ) {}

  // Dashboard statistika
  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  // Barcha userlar — faollik ko'rsatkichlari bilan
  @Get('users')
  getUsers() {
    return this.stats.users();
  }

  // Statistika hisoboti: day | week | month | year
  @Get('stats/report')
  statsReport(@Query('period') period: string) {
    return this.stats.report((period || 'week') as Period);
  }

  // Google Search Console: umumiy ko'rinish (7 | 28 | 90 kun)
  @Get('search-console')
  searchConsoleOverview(@Query('days') days: string) {
    return this.searchConsole.overview(Number(days) || 28);
  }

  // Google Search Console: so'nggi maqolalar indekslanganmi
  @Get('search-console/indexing')
  searchConsoleIndexing(@Query('refresh') refresh: string) {
    return this.searchConsole.indexing(20, refresh === '1');
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

  // AI qoralama (fonda): mavzu yoki Wikipedia havolasi bo'yicha (bo'sh — bo'lim navbatidan AI tanlaydi)
  @Post('drafts/generate')
  generateDraft(
    @Request() req: any,
    @Body() body: { topic?: string; categoryId?: number; source?: string },
  ) {
    return this.drafts.startGenerate({
      topic: body?.topic,
      categoryId: body?.categoryId ? +body.categoryId : undefined,
      source:
        body?.source === 'search' || body?.source === 'school'
          ? body.source
          : undefined,
      authorId: req.user?.userId,
    });
  }

  // Fonda yozilayotgan qoralama holati
  @Get('drafts/job')
  draftJob() {
    return { job: this.drafts.getJob() };
  }

  // Muqovani xavfsiz tizim bilan qayta tanlash (AI)
  @Post('articles/:id/cover/regenerate')
  regenerateCover(@Param('id') id: string) {
    return this.drafts.regenerateCover(+id);
  }

  // Maqolalar seriyasi: ro'yxat (qoralama qismlar va navbatdagilar bilan), CRUD,
  // AI reja va rejani kunlik navbatga qo'shish
  @Get('series')
  seriesList() {
    return this.series.adminList();
  }

  @Post('series')
  seriesCreate(@Body() body: { title?: string; description?: string }) {
    return this.series.create(body);
  }

  @Put('series/:id')
  seriesUpdate(
    @Param('id') id: string,
    @Body()
    body: { title?: string; description?: string; articleIds?: number[] },
  ) {
    return this.series.update(+id, body);
  }

  @Delete('series/:id')
  seriesRemove(@Param('id') id: string) {
    return this.series.remove(+id);
  }

  // AI: mavjud maqolalardan seriya yig'ish / yangi seriya boshlash (darhol)
  @Post('series/auto/existing')
  seriesAutoExisting() {
    return this.drafts.seriesFromExisting();
  }

  @Post('series/auto/new')
  async seriesAutoNew() {
    return { created: await this.drafts.maybeAutoSeries(true) };
  }

  @Post('series/:id/plan')
  seriesPlan(@Param('id') id: string, @Body() body: { parts?: number }) {
    return this.series.plan(+id, Number(body?.parts) || 4);
  }

  @Post('series/:id/enqueue')
  seriesEnqueue(@Param('id') id: string, @Body() body: { parts?: unknown }) {
    return this.series.enqueue(+id, body?.parts);
  }

  // Maktab bo'limi: belgilangan maqolalar; fan/sinfni o'zgartirish,
  // /maktab'dan olib tashlash (hidden) yoki qaytarish, yangi maqola qo'shish
  @Get('school')
  schoolList() {
    return this.school.adminList();
  }

  @Put('school/:articleId')
  schoolSave(
    @Param('articleId') articleId: string,
    @Body() body: { subject?: string; grade?: number | null; hidden?: boolean },
  ) {
    return this.school.adminSave(+articleId, body ?? {});
  }

  // Adminga shaxsiy Telegram xabarlari: holat, ulash, tekshirish, sinov, uzish
  @Get('alerts/telegram')
  alertsStatus() {
    return this.alerts.status();
  }

  @Post('alerts/telegram/link')
  alertsLink() {
    return this.alerts.createLink();
  }

  @Post('alerts/telegram/check')
  alertsCheck() {
    return this.alerts.checkLink();
  }

  @Post('alerts/telegram/test')
  async alertsTest() {
    return {
      sent: await this.alerts.send(
        '🔔 <b>Sinov xabari</b>\n\nBilim Manba admin xabarlari ishlayapti.',
      ),
    };
  }

  @Delete('alerts/telegram')
  alertsUnlink() {
    return this.alerts.unlink();
  }

  // Kunlik AI qoralama sozlamalari va mavzular navbati
  @Get('drafts/settings')
  draftSettings() {
    return this.drafts.getSettings();
  }

  @Put('drafts/settings')
  updateDraftSettings(
    @Body() body: { daily?: boolean; topics?: string[]; autoSeries?: boolean },
  ) {
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
