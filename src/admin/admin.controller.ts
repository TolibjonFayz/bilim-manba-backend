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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminService } from './admin.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin')
export class AdminController {
  constructor(private adminService: AdminService) {}

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
