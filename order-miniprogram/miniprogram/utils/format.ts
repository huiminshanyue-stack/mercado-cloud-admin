const countryMap: Record<string,{ name:string;flag:string }> = {
  AR:{ name:'阿根廷',flag:'🇦🇷' },BR:{ name:'巴西',flag:'🇧🇷' },CL:{ name:'智利',flag:'🇨🇱' },
  CO:{ name:'哥伦比亚',flag:'🇨🇴' },MX:{ name:'墨西哥',flag:'🇲🇽' },PE:{ name:'秘鲁',flag:'🇵🇪' },
  UY:{ name:'乌拉圭',flag:'🇺🇾' },EC:{ name:'厄瓜多尔',flag:'🇪🇨' },VE:{ name:'委内瑞拉',flag:'🇻🇪' },
  BO:{ name:'玻利维亚',flag:'🇧🇴' },PY:{ name:'巴拉圭',flag:'🇵🇾' }
};

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  const text=String(value || '').trim();
  const match=text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/i);
  if (!match) return Number.NaN;
  const year=Number(match[1]),month=Number(match[2])-1,day=Number(match[3]);
  const hour=Number(match[4] || 0),minute=Number(match[5] || 0),second=Number(match[6] || 0);
  const millisecond=Number(String(match[7] || '0').padEnd(3,'0'));
  if (!match[8] && !match[9]) return new Date(year,month,day,hour,minute,second,millisecond).getTime();
  let timestamp=Date.UTC(year,month,day,hour,minute,second,millisecond);
  if (match[9]) {
    const offset=(Number(match[10] || 0)*60+Number(match[11] || 0))*60000;
    timestamp += match[9] === '+' ? -offset : offset;
  }
  return timestamp;
}

export function formatDate(value?: string | null): string {
  if (!value) return '-';
  const timestamp=parseTimestamp(value);
  if (!Number.isFinite(timestamp)) return '-';
  const date = new Date(timestamp+8*3600000);
  const pad = (n:number) => String(n).padStart(2,'0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function money(value: unknown,currency = 'USD'): string {
  if (value === null || value === undefined || value === '') return '待获取';
  const amount = Number(value);
  return Number.isFinite(amount) ? `${currency} ${amount.toFixed(2)}` : '待获取';
}

export function countryInfo(code?: string): { name:string;flag:string } {
  return countryMap[String(code || '').toUpperCase()] || { name:code || '未知',flag:'🌐' };
}

export function orderState(order:any): string {
  const refund=Number(order.refundAmount || 0),paid=Number(order.paidAmount || 0);
  if (refund>0 || order.status === 'refunded') return paid>0 && refund+0.001<paid ? '部分退款' : '已退款';
  if (order.status === 'cancelled') return '订单取消';
  if (order.shipmentStatus === 'delivered') return '已送达';
  if (order.shipmentStatus === 'shipped') return '运输中';
  return '待发货';
}

export function cancellationText(value?:string): string {
  if (!value) return '美客多未返回取消原因';
  const raw=String(value).trim(),separator=raw.indexOf('|');
  const actor=(separator>=0 ? raw.slice(0,separator) : '').toLowerCase();
  const key=(separator>=0 ? raw.slice(separator+1) : raw).toLowerCase().trim();
  const exact:Record<string,string>={
    buyer_cancelled:'买家主动取消',seller_cancelled:'卖家取消',fraud:'美客多风控取消',
    payment_required:'买家未完成付款',expired:'订单超时取消',
    'a fraud tag cancel the order':'美客多风控判定订单存在欺诈风险',
    'purchases has splitted the pack':'该订单商品已被拆分为多个包裹',
    'the shipment was not delivered':'包裹未能成功送达','buyer regrets purchase':'买家改变购买意愿',
    'buyer did not pay':'买家未完成付款','seller did not ship on time':'卖家未按时发货',
    'mediations cancel the order':'售后调解完成并取消订单','mediation cancel the order':'售后调解完成并取消订单'
  };
  let detail=exact[key];
  if (!detail && key.includes('mediation')) detail='售后调解导致订单取消';
  if (!detail && key.includes('fraud')) detail='美客多风控判定订单存在欺诈风险';
  if (!detail && key.includes('not delivered')) detail='包裹未能成功送达';
  if (!detail && key.includes('buyer') && key.includes('cancel')) detail='买家主动取消';
  if (!detail && (key.includes('payment') || key.includes('pay'))) detail='买家付款问题导致取消';
  if (!detail && (key.includes('shipment') || key.includes('shipping'))) detail='物流履约问题导致取消';
  detail ||= '其他原因';
  if (actor.includes('buyer')) return `买家主动取消（${detail}）`;
  if (actor.includes('seller')) return `卖家取消（${detail}）`;
  if (actor.includes('mercado') || actor.includes('fraud')) return `美客多平台取消（${detail}）`;
  return detail;
}

export function deadlineText(order:any): string {
  const state=orderState(order);
  if (state!=='待发货') return state;
  if (!order.handlingDeadline) return '待发货时间：同步后计算';
  const deadline=parseTimestamp(order.handlingDeadline);
  if (!Number.isFinite(deadline)) return '待发货时间：同步后计算';
  const prefix=order.deadlineIsEstimated ? '预计' : '官方';
  const remaining=deadline-Date.now();
  if (remaining<=0) return `已超过${prefix}发货时间`;
  const hours=Math.ceil(remaining/3600000);
  return hours<=24 ? `${prefix}剩余 ${hours} 小时，可能延误` : `${prefix}待发货截止：${formatDate(order.handlingDeadline)}`;
}

export function onlineDeadlineText(order:any): string {
  if (orderState(order)!=='待发货') return '已结束计时';
  if (!order.handlingDeadline) return '待获取基础时效';
  const base=parseTimestamp(order.handlingDeadline);
  if (!Number.isFinite(base)) return '待获取基础时效';
  if (Date.now()<base) return `基础时效结束后开始（${formatDate(order.handlingDeadline)}）`;
  const remaining=base+24*3600000-Date.now();
  return remaining<=0 ? '已超过上网时限' : `剩余 ${Math.ceil(remaining/3600000)} 小时`;
}

function compact(value:unknown): string {
  if (value===null || value===undefined || value==='') return '';
  const parsed=Number(value);
  return Number.isFinite(parsed) ? String(Number(parsed.toFixed(2))) : String(value);
}

function dimensionValue(snapshot:any,mode:'seller'|'platform'): any {
  if (mode==='seller') {
    return snapshot?.verifiedPackage || snapshot?.package?.dimensions || snapshot?.declaredAtOrder || snapshot?.orderRecorded || snapshot?.items?.[0]?.orderDimensions || null;
  }
  return snapshot?.platformReturned || snapshot?.currentListing ||
    snapshot?.items?.find((item:any)=>item?.listingDimensions)?.listingDimensions ||
    snapshot?.billableWeight || snapshot?.items?.find((item:any)=>item?.billableWeight)?.billableWeight || null;
}

export function platformDimensionSourceNote(snapshot:any): string {
  const hasDimensions=Boolean(snapshot?.currentListing || snapshot?.items?.some((item:any)=>item?.listingDimensions));
  return hasDimensions ? '美客多称重核验后反馈（单件）' : '美客多官方仅返回计费重量';
}

export function dimensionSummary(snapshot:any,mode:'seller'|'platform'): string {
  const value=dimensionValue(snapshot,mode);
  if (!value) return '暂未获取';
  const length=compact(value.length),width=compact(value.width),height=compact(value.height),weight=compact(value.weight);
  const size=length && width && height ? `${length}×${width}×${height} ${value.dimensionUnit || 'cm'}` : '尺寸暂未返回';
  return `${size} / ${weight ? `重量 ${weight} ${value.weightUnit || 'g'}` : '重量未返回'}`;
}

function weightInGrams(value:any): number|null {
  const parsed=Number(value?.weight);
  if (!Number.isFinite(parsed)) return null;
  const unit=String(value?.weightUnit || 'g').trim().toLowerCase();
  if (['kg','kgs','kilogram','kilograms','公斤','千克'].includes(unit)) return parsed*1000;
  if (['mg','milligram','milligrams','毫克'].includes(unit)) return parsed/1000;
  if (['lb','lbs','磅'].includes(unit)) return parsed*453.59237;
  if (['oz','盎司'].includes(unit)) return parsed*28.349523125;
  return parsed;
}

function quantityForItem(orderItems:any[],itemId:string,singleFallback:boolean): number {
  const matched=itemId
    ? orderItems.filter(entry=>String(entry?.item?.id || entry?.item_id || '')===itemId)
    : (singleFallback && orderItems.length===1 ? orderItems : []);
  const quantity=matched.reduce((total,entry)=>total+Math.max(0,Number(entry?.quantity) || 0),0);
  return Math.max(1,quantity || 1);
}

function platformTotalWeight(orderItems:any[],snapshot:any): number|null {
  const records=(snapshot?.items || []).filter((item:any)=>item?.listingDimensions);
  if (!records.length) {
    const single=weightInGrams(dimensionValue(snapshot,'platform'));
    const quantity=orderItems.reduce((total,entry)=>total+Math.max(0,Number(entry?.quantity) || 0),0);
    return single===null ? null : single*Math.max(1,quantity || 1);
  }
  let total=0,found=false;
  records.forEach((record:any)=>{
    const single=weightInGrams(record.listingDimensions);
    if (single===null) return;
    total+=single*quantityForItem(orderItems,String(record.itemId || ''),records.length===1);
    found=true;
  });
  return found ? total : null;
}

export function dimensionWeightState(orderItems:any[],snapshot:any): { sellerHint:string,sellerHintClass:string,weightAnomaly:boolean } {
  const seller=weightInGrams(dimensionValue(snapshot,'seller'));
  const platform=platformTotalWeight(Array.isArray(orderItems) ? orderItems : [],snapshot);
  if (seller===null || platform===null) return { sellerHint:'',sellerHintClass:'',weightAnomaly:false };
  const tolerance=Math.max(0.01,Math.max(Math.abs(seller),Math.abs(platform))*0.0001);
  if (Math.abs(seller-platform)<=tolerance) return { sellerHint:'与当前记录重量一致',sellerHintClass:'is-equal',weightAnomaly:false };
  if (seller<platform) return { sellerHint:'低于当前记录重量',sellerHintClass:'is-lower',weightAnomaly:true };
  return { sellerHint:'高于当前记录重量',sellerHintClass:'is-higher',weightAnomaly:false };
}

export function reputationReasonText(value:unknown): string {
  const key=String(value || '').toLowerCase();
  const exact:Record<string,string>={ negative_feedback:'买家给出差评',neutral_feedback:'买家给出中评',not_delivered:'订单未按要求送达',delayed:'订单发货或配送延误',seller_cancelled:'卖家取消订单',mediation:'订单进入售后调解',claim:'买家发起售后投诉',product_not_received:'买家未收到商品',item_not_received:'买家未收到商品',product_not_as_described:'商品与描述不符',different_product:'买家收到的商品不符',defective_product:'商品存在质量或功能问题',damaged_product:'商品送达时发生破损' };
  if (exact[key]) return exact[key];
  if (key.includes('negative')) return '买家给出差评';
  if (key.includes('deliver')) return '订单未按要求送达';
  if (key.includes('delay')) return '订单发货或配送延误';
  if (key.includes('cancel')) return '订单取消责任计入卖家';
  if (key.includes('mediation')) return '订单进入售后调解';
  return value ? String(value) : '美客多判定该订单影响店铺声誉';
}
