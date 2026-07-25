import { request,showError } from '../../utils/request';
import { countryInfo,formatDate,reputationReasonText } from '../../utils/format';
import { createRealtimeWatcher } from '../../utils/realtime';

const realtimeWatcher=createRealtimeWatcher();

function normalize(claim:any,storeNames:Map<string,string>) {
  const order=claim.order || {},item=order.items?.[0]?.item || {},country=countryInfo(order.country),storeId=String(claim.storeId || order.storeId || '');
  return { ...claim,key:`${storeId}:${claim.id}`,storeId,orderNo:String(order.packId || order.orderId || '-'),orderId:String(order.orderId || ''),buyer:order.buyer || '-',storeName:storeNames.get(storeId) || '授权店铺',countryText:`${country.flag} ${country.name}`,dateText:formatDate(claim.last_updated || claim.date_created || order.dateCreated),reasonText:reputationReasonText(claim.reason_id || claim.type || claim.status_detail || '售后问题'),productTitle:item.title || '商品信息待获取',productImage:item.picture_url || item.thumbnail || '' };
}

Page({
  data:{ loading:false,claims:[] as any[],errors:[] as string[] },
  onShow() {
    this.loadData();
    realtimeWatcher.start(state=>{ if (state.lastTopic === 'claims') return this.loadData(); });
  },
  onHide() { realtimeWatcher.stop(); },
  onUnload() { realtimeWatcher.stop(); },
  async onPullDownRefresh() { await this.loadData(); wx.stopPullDownRefresh(); },
  async loadData() {
    if (this.data.loading) return;
    this.setData({ loading:true,errors:[] });
    try {
      const stores=await request<any[]>({ path:'/api/miniprogram/v1/stores' });
      const names=new Map(stores.map(store=>[String(store.id),store.displayName || store.nickname || String(store.id)]));
      const results=await Promise.allSettled(stores.map(store=>request<any>({ path:`/api/miniprogram/v1/after-sales?storeId=${encodeURIComponent(store.id)}`,timeout:60000 })));
      const map=new Map<string,any>(),errors:string[]=[];
      results.forEach((result,index)=>{
        if (result.status==='fulfilled') for (const claim of result.value.items || []) { const item=normalize(claim,names); map.set(item.key,item); }
        else errors.push(`${names.get(String(stores[index].id))}：${result.reason?.message || '读取失败'}`);
      });
      this.setData({ claims:[...map.values()],errors });
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  },
  openThread(event:WechatMiniprogram.TouchEvent) {
    const claim=this.data.claims.find(item=>item.key===String(event.currentTarget.dataset.key));
    if (!claim) return;
    wx.navigateTo({ url:`/pages/claim-thread/index?claimId=${encodeURIComponent(claim.id)}&storeId=${encodeURIComponent(claim.storeId)}&orderNo=${encodeURIComponent(claim.orderNo)}` });
  }
});
