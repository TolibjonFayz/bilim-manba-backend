import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';

@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(private categoriesService: CategoriesService) {}

  // Get all categories
  @ApiOperation({ summary: 'Get all categories' })
  @Get('all')
  async findAll() {
    return this.categoriesService.findAll();
  }

  // Get category by slug
  @ApiOperation({ summary: 'Get category by slug' })
  @Get('byslug/:slug')
  async findOne(@Param('slug') slug: string) {
    return this.categoriesService.findBySlug(slug);
  }

  // Create category
  @ApiOperation({ summary: 'Create category' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('create')
  async create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  // Update category
  @ApiOperation({ summary: 'Update category' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Put('update/:id')
  update(@Param('id') id: string, @Body() dto: CreateCategoryDto) {
    return this.categoriesService.update(+id, dto);
  }

  // Delete category
  @ApiOperation({ summary: 'Delete category' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('delete/:id')
  async remove(@Param('id') id: string) {
    return this.categoriesService.remove(+id);
  }
}
