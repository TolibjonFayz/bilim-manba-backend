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
import { OptionalJwtGuard } from 'src/auth/guards/optional-jwt.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateArticleDto } from './dto/create-article.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ArticlesService } from './articles.service';
import { RateLimit, takeToken } from '../common/rate-limit';
import { clientIp } from '../common/client-ip';

/** ?q=a&q=b yoki ?q[x]=y kabi g'alati qiymatlar bazaga yetib bormasin */
const oneString = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v ? v.slice(0, max) : undefined;

@ApiTags('Articles')
@Controller('articles')
export class ArticlesController {
  constructor(private articlesService: ArticlesService) {}

  // Hammaga ochiq
  @ApiOperation({ summary: 'Get all articles' })
  @Get('all')
  findAll(@Query('category') category?: unknown) {
    return this.articlesService.findAll(oneString(category, 200));
  }

  // Token bo'lsa plan tekshiriladi, bo'lmasa 'free' hisoblanadi
  @ApiOperation({ summary: 'Get article by slug' })
  @UseGuards(OptionalJwtGuard)
  @Get('byslug/:slug')
  findOne(@Param('slug') slug: string, @Request() req: any) {
    const userId = req.user?.userId;
    return this.articlesService.findBySlug(slug, userId);
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
  @UseGuards(JwtAuthGuard, RolesGuard)
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

  // findAll dan keyin qo'sh
  @ApiOperation({ summary: 'Search articles' })
  @RateLimit(60, 60)
  @Get('search')
  search(@Query('q') q: unknown) {
    return this.articlesService.search(oneString(q, 100) ?? '');
  }

  // Maqola oxiridagi testni tugatdi (hammaga ochiq): to'g'ri javoblar soni 0–3
  // Token bo'lsa — test bali foydalanuvchiga yoziladi (reyting)
  @RateLimit(30, 60)
  @UseGuards(OptionalJwtGuard)
  @Post('quiz-result/:slug')
  quizResult(
    @Param('slug') slug: string,
    @Body() body: { correct?: number; answers?: number[] },
    @Request() req: any,
  ) {
    return this.articlesService.quizResult(
      slug,
      Number(body?.correct),
      body?.answers,
      req.user?.userId,
    );
  }

  // Token bo'lsa — o'qish foydalanuvchi tarixiga yoziladi (avval guard yo'q
  // edi va hech qachon yozilmasdi)
  @RateLimit(60, 60)
  @UseGuards(OptionalJwtGuard)
  @Post('view/:slug')
  recordView(@Param('slug') slug: string, @Request() req: any) {
    // Ko'rishlar sonini sun'iy oshirishga qarshi: bitta IP dan bitta maqola
    // 10 daqiqada ko'pi bilan 3 marta hisoblanadi
    const key = `view:${clientIp(req)}:${slug.slice(0, 200)}`;
    if (!takeToken(key, 3, 10 * 60 * 1000)) return { success: true };
    const userId = req.user?.userId;
    return this.articlesService.recordView(slug, userId);
  }

  @Get('sitemap')
  getSitemap() {
    return this.articlesService.getSitemapData();
  }
}
