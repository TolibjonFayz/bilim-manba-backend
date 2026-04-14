import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Delete,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SubscriptionService } from './subscription.service';
import { ActivatePremiumDto } from './dto/activate-premium.dto';

@ApiTags('Subscription')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard) // Barcha endpoint'lar login talab qiladi
@Controller('subscription')
export class SubscriptionController {
  constructor(private subscriptionService: SubscriptionService) {}

  // User o'z statusini ko'radi — necha kun qolgan va h.k.
  @Get('status')
  getMyStatus(@Request() req) {
    return this.subscriptionService.getStatus(req.user.userId);
  }

  // Admin: barcha premium userlar
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Get('premium-users')
  findAllPremium() {
    return this.subscriptionService.findAllPremiumUsers();
  }

  // Admin: biror userni premium qilish
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post('activate/:userId')
  activate(@Param('userId') userId: string, @Body() dto: ActivatePremiumDto) {
    return this.subscriptionService.activatePremium(+userId, dto);
  }

  // Admin: premiumni bekor qilish
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Delete('deactivate/:userId')
  deactivate(@Param('userId') userId: string) {
    return this.subscriptionService.deactivatePremium(+userId);
  }
}
