import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ExplainDto } from './dto/explain.dto.ts';
import { AiService } from './ai.service';

@ApiTags('AI')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(private aiService: AiService) {}

  @Post('explain')
  explain(@Body() dto: ExplainDto, @Request() req) {
    return this.aiService.explain(dto, req.user.plan);
  }
}
