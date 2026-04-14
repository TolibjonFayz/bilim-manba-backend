export class PaymeRequestDto {
  method: string;
  params: {
    id?: string;
    time?: number;
    amount?: number;
    account?: { user_id: number };
    reason?: number;
  };
  id: number; // JSON-RPC id
}
