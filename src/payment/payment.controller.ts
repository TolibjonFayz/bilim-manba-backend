import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from './payment.service';
import { PaymeRequestDto } from './dto/payme.dto';

@ApiTags('Payme')
@Controller('payment/payme')
export class PaymeController {
  // Tranzaksiyalarni xotirada saqlaymiz
  // Prodda DB ga ko'chirish kerak!
  private transactions = new Map<string, any>();

  constructor(
    private paymentService: PaymentService,
    private config: ConfigService,
  ) {}

  @Post()
  async handle(
    @Body() body: PaymeRequestDto,
    @Headers('authorization') auth: string,
  ) {
    // Payme dan kelgan so'rovni tekshiramiz
    if (!this.checkAuth(auth)) {
      return this.error(body.id, -32504, 'Avtorizatsiya xatosi');
    }

    // Qaysi metod kelganiga qarab ishlaymiz
    switch (body.method) {
      case 'CheckPerformTransaction':
        return this.checkPerformTransaction(body);
      case 'CreateTransaction':
        return this.createTransaction(body);
      case 'PerformTransaction':
        return this.performTransaction(body);
      case 'CancelTransaction':
        return this.cancelTransaction(body);
      case 'CheckTransaction':
        return this.checkTransaction(body);
      default:
        return this.error(body.id, -32601, 'Metod topilmadi');
    }
  }

  // Payme Basic Auth ni tekshiramiz
  private checkAuth(auth: string): boolean {
    const isTest = this.config.get('PAYME_IS_TEST') === 'true';
    const key = isTest
      ? this.config.get('PAYME_TEST_SECRET_KEY')
      : this.config.get('PAYME_SECRET_KEY');
    const merchantId = this.config.get('PAYME_MERCHANT_ID');

    const expected = Buffer.from(`${merchantId}:${key}`).toString('base64');
    return auth === `Basic ${expected}`;
  }

  // 1. To'lov qilsa bo'ladimi?
  private async checkPerformTransaction(body: PaymeRequestDto) {
    const { amount, account } = body.params;

    if (!this.paymentService.validateAmount(amount!)) {
      return this.error(body.id, -31001, "Summa noto'g'ri");
    }

    return {
      id: body.id,
      result: { allow: true },
    };
  }

  // 2. Tranzaksiya yaratish
  private async createTransaction(body: PaymeRequestDto) {
    const { id, time, amount, account } = body.params;

    // Mavjud tranzaksiyami?
    if (this.transactions.has(id!)) {
      const t = this.transactions.get(id!);
      if (t.state !== 1)
        return this.error(body.id, -31008, 'Tranzaksiya yaroqsiz');
      return {
        id: body.id,
        result: { create_time: t.createTime, transaction: id, state: 1 },
      };
    }

    if (!this.paymentService.validateAmount(amount!)) {
      return this.error(body.id, -31001, "Summa noto'g'ri");
    }

    // Yangi tranzaksiya saqlaymiz
    this.transactions.set(id!, {
      id,
      userId: account!.user_id,
      amount,
      state: 1, // 1 = yaratildi
      createTime: time,
    });

    return {
      id: body.id,
      result: { create_time: time, transaction: id, state: 1 },
    };
  }

  // 3. Pul o'tdi — premium beramiz!
  private async performTransaction(body: PaymeRequestDto) {
    const { id } = body.params;
    const t = this.transactions.get(id!);

    if (!t) return this.error(body.id, -31003, 'Tranzaksiya topilmadi');
    if (t.state === 2) {
      return {
        id: body.id,
        result: { perform_time: t.performTime, transaction: id, state: 2 },
      };
    }
    if (t.state !== 1)
      return this.error(body.id, -31008, 'Tranzaksiya yaroqsiz');

    // Premium beramiz!
    await this.paymentService.grantPremium(t.userId);

    const performTime = Date.now();
    t.state = 2; // 2 = bajarildi
    t.performTime = performTime;
    this.transactions.set(id!, t);

    return {
      id: body.id,
      result: { perform_time: performTime, transaction: id, state: 2 },
    };
  }

  // Bekor qilish
  private async cancelTransaction(body: PaymeRequestDto) {
    const { id, reason } = body.params;
    const t = this.transactions.get(id!);

    if (!t) return this.error(body.id, -31003, 'Tranzaksiya topilmadi');

    t.state = t.state === 1 ? -1 : -2;
    t.reason = reason;
    t.cancelTime = Date.now();
    this.transactions.set(id!, t);

    return {
      id: body.id,
      result: { cancel_time: t.cancelTime, transaction: id, state: t.state },
    };
  }

  // Tranzaksiya holati
  private checkTransaction(body: PaymeRequestDto) {
    const { id } = body.params;
    const t = this.transactions.get(id!);

    if (!t) return this.error(body.id, -31003, 'Tranzaksiya topilmadi');

    return {
      id: body.id,
      result: {
        create_time: t.createTime,
        perform_time: t.performTime ?? 0,
        cancel_time: t.cancelTime ?? 0,
        transaction: id,
        state: t.state,
        reason: t.reason ?? null,
      },
    };
  }

  // JSON-RPC error format
  private error(id: number, code: number, message: string) {
    return {
      id,
      error: { code, message: { ru: message, uz: message, en: message } },
    };
  }
}
