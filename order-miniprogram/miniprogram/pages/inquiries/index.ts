import { request,showError } from '../../utils/request';
import { countryInfo,formatDate } from '../../utils/format';
import { createRealtimeWatcher } from '../../utils/realtime';

const realtimeWatcher=createRealtimeWatcher();

function normalize(order:any,storeNames:Map<string,string>) {
  const item=order.items?.[0]?.item || {},country=countryInfo(order.country);
  const isProductQuestion=order.inquiryType === 'product_question';
  const productImage=String(item.picture_url || item.secure_thumbnail || item.thumbnail || '').replace(/^http:/i,'https:');
  return { ...order,isProductQuestion,key:String(order.orderId),displayOrderId:isProductQuestion ? `售前问题 ${order.questionId}` : String(order.packId || order.orderId),storeName:storeNames.get(String(order.storeId)) || '授权店铺',countryText:`${country.flag} ${country.name}`,dateText:formatDate(order.dateCreated),productTitle:item.title || '商品信息待获取',productImage };
}

Page({
  data:{
    loading:false,orders:[] as any[],errors:[] as string[],channel:'product_question',
    pageTitle:'商品售前问题',introTitle:'商品售前待回复',
    introDesc:'买家下单前针对商品发来的公开问题，输入中文后翻译为英文，确认后发送。',
    loadingText:'正在检查所有授权店铺的商品售前问题…',emptyText:'目前没有待回复商品售前问题'
  },
  onLoad(options:Record<string,string | undefined>) {
    const channel=options.channel==='order_message' ? 'order_message' : 'product_question';
    const isOrderMessage=channel==='order_message';
    const pageTitle=isOrderMessage ? '订单咨询消息' : '商品售前问题';
    this.setData({
      channel,pageTitle,
      introTitle:isOrderMessage ? '订单咨询待回复' : '商品售前待回复',
      introDesc:isOrderMessage
        ? '买家下单后针对订单发来的私信咨询，输入中文后翻译为英文，确认后发送。'
        : '买家下单前针对商品发来的公开问题，输入中文后翻译为英文，确认后发送。',
      loadingText:isOrderMessage ? '正在检查所有授权店铺的订单咨询…' : '正在检查所有授权店铺的商品售前问题…',
      emptyText:isOrderMessage ? '目前没有待回复订单咨询' : '目前没有待回复商品售前问题'
    });
    wx.setNavigationBarTitle({ title:pageTitle });
  },
  onShow() {
    this.loadData();
    realtimeWatcher.start(state=>{ if (state.lastTopic === 'messages' || state.lastTopic === 'communications') return this.loadData(); });
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
      const results=await Promise.allSettled(stores.map(store=>request<any>({ path:`/api/miniprogram/v1/inquiries?storeId=${encodeURIComponent(store.id)}&channel=${this.data.channel}`,timeout:60000 })));
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
    wx.navigateTo({ url:`/pages/inquiry-thread/index?orderId=${encodeURIComponent(order.orderId)}&storeId=${encodeURIComponent(order.storeId)}&orderNo=${encodeURIComponent(order.displayOrderId)}&channel=${this.data.channel}` });
  }
});
