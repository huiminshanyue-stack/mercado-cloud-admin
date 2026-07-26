import { request,showError } from '../../utils/request';
import { countryInfo,formatDate,money,orderState } from '../../utils/format';
import { createRealtimeWatcher } from '../../utils/realtime';

const realtimeWatcher=createRealtimeWatcher();

const statusOptions = [
  { name:'全部状态',value:'' },{ name:'待发货',value:'ready_to_ship' },{ name:'运输中',value:'shipped' },
  { name:'已送达',value:'delivered' },{ name:'订单取消',value:'cancelled' },{ name:'已退款',value:'refunded' }
];

const periodTabs = [
  { name:'今日订单',value:'today' },{ name:'本周订单',value:'week' },{ name:'本月订单',value:'month' }
];

function formatWorkbenchSummary(result:any) {
  return {
    orderCount:Number(result.orderCount || 0),
    salesText:Number(result.salesCny || 0).toFixed(2),
    profitText:Number(result.profitCny || 0).toFixed(2),
    profitRateText:result.profitRate===null || result.profitRate===undefined ? '--' : `${Number(result.profitRate).toFixed(1)}%`,
    pendingPayoutCount:Number(result.pendingPayoutCount || 0),
    exchangeRateText:Number(result.exchangeRate || 0).toFixed(4)
  };
}

function normalize(order:any) {
  const products = (Array.isArray(order.items) ? order.items : []).map((product:any,index:number) => {
    const item = product.item || {};
    const sku = item.seller_sku || item.seller_custom_field || item.sku || '-';
    return {
      productKey:`${item.id || 'item'}:${item.variation_id || sku || 'variation'}:${index}`,
      title:item.title || '商品信息待获取',image:item.picture_url || item.thumbnail || '',
      quantity:Math.max(1,Number(product.quantity || 1)),sku,
      color:item.colorNameZh || item.color_name_zh || '-'
    };
  });
  const stateText = orderState(order);
  const stateKey = stateText === '待发货' ? 'pending' : stateText === '运输中' ? 'shipping' : stateText === '已送达' ? 'done' : 'closed';
  const country = countryInfo(order.country);
  return {
    ...order,
    displayOrderId:String(order.displayOrderId || order.orderId),stateText,stateKey,
    countryName:country.name,countryFlag:country.flag,dateText:formatDate(order.dateCreated),
    dispatchDeadlineText:stateKey === 'pending'
      ? (order.handlingDeadline
        ? `${order.deadlineIsEstimated ? '预计' : '官方'}待发货截止：${formatDate(order.handlingDeadline)}`
        : '预计待发货截止：同步后计算')
      : '',
    products,productCount:products.reduce((total:number,product:any)=>total+product.quantity,0),
    grossText:money(order.grossAmountUsd ?? order.paidAmount,'USD'),
    payoutText:money(order.netAmountUsd,'USD'),costText:Number(order.productCost || 0).toFixed(2)
  };
}

Page({
  data:{
    loading:false,page:1,size:20,total:0,hasMore:true,orders:[] as any[],stores:[] as any[],
    storeNames:['全部店铺'],storeIndex:0,statusNames:statusOptions.map(i=>i.name),statusIndex:0,
    orderId:'',userName:'内测账号',loadedOnce:false,
    periodTabs,summaryPeriod:'today',summaryLoading:false,allSummaryLoading:false,
    workbenchSummary:{ orderCount:0,salesText:'--',profitText:'--',profitRateText:'--',pendingPayoutCount:0,exchangeRateText:'--' },
    allTimeSummary:{ orderCount:0,salesText:'--',profitText:'--',profitRateText:'--',pendingPayoutCount:0,exchangeRateText:'--' }
  },
  async onLoad() {
    const app = getApp<IAppOption>();
    if (!app.globalData.token) {
      wx.reLaunch({ url:'/pages/login/index' });
      return;
    }
    this.setData({ userName:app.globalData.user?.nickname || app.globalData.user?.username || '内测账号' });
    await this.loadStores();
    await Promise.all([this.loadOrders(true),this.loadSummary(),this.loadAllTimeSummary()]);
    this.setData({ loadedOnce:true });
  },
  onShow() {
    if (this.data.loadedOnce) Promise.all([this.loadOrders(true),this.loadSummary(),this.loadAllTimeSummary()]);
    realtimeWatcher.start(state=>{
      if (state.lastTopic === 'orders_v2' || state.lastTopic === 'shipments') Promise.all([this.loadOrders(true),this.loadSummary(),this.loadAllTimeSummary()]);
    });
  },
  onHide() { realtimeWatcher.stop(); },
  onUnload() { realtimeWatcher.stop(); },
  async onPullDownRefresh() { await Promise.all([this.loadOrders(true),this.loadSummary(),this.loadAllTimeSummary()]); wx.stopPullDownRefresh(); },
  async onReachBottom() { if (this.data.hasMore && !this.data.loading) await this.loadOrders(false); },
  onOrderId(event:WechatMiniprogram.Input) { this.setData({ orderId:event.detail.value.trim() }); },
  async onStoreChange(event:WechatMiniprogram.PickerChange) { this.setData({ storeIndex:Number(event.detail.value) }); await Promise.all([this.loadOrders(true),this.loadSummary()]); },
  async onStatusChange(event:WechatMiniprogram.PickerChange) { this.setData({ statusIndex:Number(event.detail.value) }); await this.loadOrders(true); },
  async applyFilters() { await this.loadOrders(true); },
  async onPeriodChange(event:WechatMiniprogram.TouchEvent) {
    const period=String(event.currentTarget.dataset.period || 'today');
    if (period===this.data.summaryPeriod) return;
    this.setData({ summaryPeriod:period });
    await this.loadSummary();
  },
  async loadStores() {
    try {
      const stores = await request<any[]>({ path:'/api/miniprogram/v1/stores' });
      this.setData({ stores,storeNames:['全部店铺',...stores.map(store=>store.displayName || store.nickname || store.id)] });
    } catch (error) { showError(error); }
  },
  async loadOrders(reset:boolean) {
    if (this.data.loading) return;
    const page = reset ? 1 : this.data.page;
    this.setData({ loading:true });
    try {
      const store = this.data.storeIndex > 0 ? this.data.stores[this.data.storeIndex-1] : null;
      const status = statusOptions[this.data.statusIndex]?.value || '';
      const query = [
        `page=${page}`,`size=${this.data.size}`,
        store ? `storeId=${encodeURIComponent(store.id)}` : '',
        status ? `fulfillmentStatus=${encodeURIComponent(status)}` : '',
        this.data.orderId ? `orderId=${encodeURIComponent(this.data.orderId)}` : ''
      ].filter(Boolean).join('&');
      const result = await request<any>({ path:`/api/miniprogram/v1/orders?${query}` });
      const incoming = (result.items || []).map(normalize);
      const orders = reset ? incoming : [...this.data.orders,...incoming];
      this.setData({ orders,total:Number(result.total || 0),page:page+1,hasMore:orders.length<Number(result.total || 0) });
    } catch (error:any) {
      if (/登录/.test(error?.message || '')) wx.reLaunch({ url:'/pages/login/index' });
      showError(error);
    } finally { this.setData({ loading:false }); }
  },
  async loadSummary() {
    const requestId=Number((this as any)._summaryRequestId || 0)+1;
    (this as any)._summaryRequestId=requestId;
    this.setData({ summaryLoading:true });
    try {
      const store=this.data.storeIndex>0 ? this.data.stores[this.data.storeIndex-1] : null;
      const query=[`period=${encodeURIComponent(this.data.summaryPeriod)}`,store ? `storeId=${encodeURIComponent(store.id)}` : ''].filter(Boolean).join('&');
      const result=await request<any>({ path:`/api/miniprogram/v1/order-workbench-summary?${query}` });
      if ((this as any)._summaryRequestId!==requestId) return;
      this.setData({ workbenchSummary:formatWorkbenchSummary(result) });
    } catch (error) { if ((this as any)._summaryRequestId===requestId) showError(error); }
    finally { if ((this as any)._summaryRequestId===requestId) this.setData({ summaryLoading:false }); }
  },
  async loadAllTimeSummary() {
    const requestId=Number((this as any)._allSummaryRequestId || 0)+1;
    (this as any)._allSummaryRequestId=requestId;
    this.setData({ allSummaryLoading:true });
    try {
      // Intentionally omit storeId: this card is the account-wide total for all authorized stores.
      const result=await request<any>({ path:'/api/miniprogram/v1/order-workbench-summary?period=all' });
      if ((this as any)._allSummaryRequestId!==requestId) return;
      this.setData({ allTimeSummary:formatWorkbenchSummary(result) });
    } catch (error) { if ((this as any)._allSummaryRequestId===requestId) showError(error); }
    finally { if ((this as any)._allSummaryRequestId===requestId) this.setData({ allSummaryLoading:false }); }
  },
  openOrder(event:WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url:`/pages/order-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },
  openCost(event:WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url:`/pages/cost/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },
  logout() {
    const app = getApp<IAppOption>();
    request({ path:'/api/miniprogram/v1/auth/logout',method:'POST' }).catch(()=>{});
    app.clearSession();
    wx.reLaunch({ url:'/pages/login/index' });
  }
});
