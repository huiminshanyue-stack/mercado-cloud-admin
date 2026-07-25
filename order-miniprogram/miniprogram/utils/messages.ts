import { formatDate } from './format';

export function messageList(payload:any): any[] {
  const source=Array.isArray(payload) ? payload : payload?.messages || payload?.results || payload?.data?.messages || [];
  return (Array.isArray(source) ? source : []).map((message:any,index:number) => ({
    ...message,
    key:String(message.id || message.message_id || `${index}:${message.date_created || message.created_at || ''}`),
    content:String(message.text || message.message || message.message_text || message.body || ''),
    timeText:formatDate(message.message_date || message.date_created || message.created_at || message.last_updated),
    roleText:messageRole(message)
  }));
}

export function messageRole(message:any): string {
  const role=String(message.sender_role || message.role || message.from?.role || '').toLowerCase();
  if (['respondent','seller','mediator'].includes(role)) return role==='mediator' ? '美客多' : '卖家';
  if (['complainant','claimant','buyer'].includes(role)) return '买家';
  return '买家';
}

export function isSellerMessage(message:any,storeId:string): boolean {
  const role=String(message.sender_role || message.role || message.from?.role || '').toLowerCase();
  if (['respondent','seller','mediator'].includes(role)) return true;
  const sender=String(message.from?.user_id || message.from?.id || message.sender_id || (typeof message.from==='string' ? message.from : ''));
  return Boolean(sender && storeId && sender===String(storeId));
}
