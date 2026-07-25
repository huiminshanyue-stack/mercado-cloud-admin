import { request,showError } from '../../utils/request';
import { countryInfo,formatDate,money,orderState } from '../../utils/format';

const statusOptions = [
  { name:'全部状态',value:'' },{ name:'待发货',value:'ready_to_ship' },{ name:'运输中',value:'shipped' },
  { name:'已送达',value:'delivered' },{ name:'订单取消',value:'cancelled' },{ name:'已退款',value:'refunded' }
];

function normalize(order:any) {
  const product = order.items?.[0] || {};
  const item = product.item || {};
  const stateText = orderState(order);
  const stateKey = stateText === '待发货' ? 'pending' : stateText === '运输中' ? 'shipping' : stateText === '已送达' ? 'done' : 'closed';
  const country = countryInfo(order.country);
  return {
    ...order,
    displayOrderId:String(order.displayOrderId || order.orderId),stateText,stateKey,
    countryName:country.name,countryFlag:country.flag,dateText:formatDate(order.dateCreated),
    productTitle:item.title || '商品信息待获取',productImage:item.picture_url || item.thumbnail || '',
    quantity:product.quantity || 1,sku:item.seller_sku || item.sku || '-',
    grossText:money(order.grossAmountUsd ?? order.paidAmount,'USD'),
    payoutText:money(order.netAmountUsd,'USD')
  };
}

Page({
  data:{
    loading:false,page:1,size:20,total:0,hasMore:true,orders:[] as any[],stores:[] as any[],
    storeNames:['全部店铺'],storeIndex:0,statusNames:statusOptions.map(i=>i.name),statusIndex:0,
    orderId:'',userName:'内测账号'
  },
  async onLoad() {
    const app = getApp<IAppOption>();
    if (!app.globalData.token) {
      wx.reLaunch({ url:'/pages/login/index' });
      return;
    }
    this.setData({ userName:app.globalData.user?.nickname || app.globalData.user?.username || '内测账号' });
    await this.loadStores();
    await this.loadOrders(true);
  },
  async onPullDownRefresh() { await this.loadOrders(true); wx.stopPullDownRefresh(); },
  async onReachBottom() { if (this.data.hasMore && !this.data.loading) await this.loadOrders(false); },
  onOrderId(event:WechatMiniprogram.Input) { this.setData({ orderId:event.detail.value.trim() }); },
  async onStoreChange(event:WechatMiniprogram.PickerChange) { this.setData({ storeIndex:Number(event.detail.value) }); await this.loadOrders(true); },
  async onStatusChange(event:WechatMiniprogram.PickerChange) { this.setData({ statusIndex:Number(event.detail.value) }); await this.loadOrders(true); },
  async applyFilters() { await this.loadOrders(true); },
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
  openOrder(event:WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url:`/pages/order-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },
  logout() {
    const app = getApp<IAppOption>();
    request({ path:'/api/miniprogram/v1/auth/logout',method:'POST' }).catch(()=>{});
    app.clearSession();
    wx.reLaunch({ url:'/pages/login/index' });
  }
});
