import { request,showError } from '../../utils/request';
import { countryInfo,formatDate } from '../../utils/format';

function normalize(order:any,storeNames:Map<string,string>) {
  const item=order.items?.[0]?.item || {},country=countryInfo(order.country);
  return { ...order,key:String(order.orderId),displayOrderId:String(order.packId || order.orderId),storeName:storeNames.get(String(order.storeId)) || '授权店铺',countryText:`${country.flag} ${country.name}`,dateText:formatDate(order.dateCreated),productTitle:item.title || '商品信息待获取',productImage:item.picture_url || item.thumbnail || '' };
}

Page({
  data:{ loading:false,orders:[] as any[],errors:[] as string[] },
  onShow() { this.loadData(); },
  async onPullDownRefresh() { await this.loadData(); wx.stopPullDownRefresh(); },
  async loadData() {
    if (this.data.loading) return;
    this.setData({ loading:true,errors:[] });
    try {
      const stores=await request<any[]>({ path:'/api/miniprogram/v1/stores' });
      const names=new Map(stores.map(store=>[String(store.id),store.displayName || store.nickname || String(store.id)]));
      const results=await Promise.allSettled(stores.map(store=>request<any>({ path:`/api/miniprogram/v1/inquiries?storeId=${encodeURIComponent(store.id)}`,timeout:60000 })));
      const map=new Map<string,any>(),errors:string[]=[];
      results.forEach((result,index)=>{
        if (result.status==='fulfilled') for (const order of result.value.orders || []) map.set(String(order.orderId),normalize(order,names));
        else errors.push(`${names.get(String(stores[index].id))}：${result.reason?.message || '读取失败'}`);
      });
      this.setData({ orders:[...map.values()],errors });
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  },
  openThread(event:WechatMiniprogram.TouchEvent) {
    const order=this.data.orders.find(item=>String(item.orderId)===String(event.currentTarget.dataset.id));
    if (!order) return;
    wx.navigateTo({ url:`/pages/inquiry-thread/index?orderId=${encodeURIComponent(order.orderId)}&storeId=${encodeURIComponent(order.storeId)}&orderNo=${encodeURIComponent(order.displayOrderId)}` });
  }
});
