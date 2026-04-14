import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ArticlesService } from './articles.service';
import { CreateArticleDto } from './dto/create-article.dto';
import { UpdateArticleDto } from './dto/update-article.dto';

@ApiTags('Articles')
@Controller('articles')
export class ArticlesController {
  constructor(private articlesService: ArticlesService) {}

  // Hammaga ochiq
  @ApiOperation({ summary: 'Get all articles' })
  @Get('all')
  findAll(@Query('category') category?: string) {
    return this.articlesService.findAll(category);
  }

  // Token bo'lsa plan tekshiriladi, bo'lmasa 'free' hisoblanadi
  @ApiOperation({ summary: 'Get article by slug' })
  @Get('byslug/:slug')
  findOne(@Param('slug') slug: string, @Request() req) {
    const userPlan = req.user?.plan ?? 'free';
    return this.articlesService.findBySlug(slug, userPlan);
  }

  // Admin routelar
  @ApiOperation({ summary: 'Get all articles (admin)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/all')
  findAllAdmin() {
    return this.articlesService.findAllAdmin();
  }

  // Create article (admin)
  @ApiOperation({ summary: 'Create article (admin)' })
  @ApiBearerAuth()
  // @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('create')
  create(@Body() dto: CreateArticleDto, @Request() req) {
    return this.articlesService.create(dto, 1);
  }

  // Update article (admin)
  @ApiOperation({ summary: 'Update article (admin)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Put('update/:id')
  update(@Param('id') id: string, @Body() dto: UpdateArticleDto) {
    return this.articlesService.update(+id, dto);
  }

  // Delete article (admin)
  @ApiOperation({ summary: 'Delete article (admin)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.articlesService.remove(+id);
  }
}
