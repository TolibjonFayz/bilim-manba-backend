import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { Category } from './models/category.model';

@Module({
  imports: [SequelizeModule.forFeature([Category])],
  providers: [CategoriesService],
  controllers: [CategoriesController],
  exports: [SequelizeModule],
})
export class CategoriesModule {}
