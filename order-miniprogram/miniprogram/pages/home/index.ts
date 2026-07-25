import { request,showError } from '../../utils/request';

Page({
  data:{ userName:'内测账号',loading:false,summary:{ orderCount:0,inquiryCount:0,afterSalesCount:0 } },
  onShow() {
    const app=getApp<IAppOption>();
    if (!app.globalData.token) { wx.reLaunch({ url:'/pages/login/index' }); return; }
    this.setData({ userName:app.globalData.user?.nickname || app.globalData.user?.username || '内测账号' });
    this.loadSummary();
  },
  async onPullDownRefresh() { await this.loadSummary(); wx.stopPullDownRefresh(); },
  async loadSummary() {
    if (this.data.loading) return;
    this.setData({ loading:true });
    try { this.setData({ summary:await request<any>({ path:'/api/miniprogram/v1/home-summary' }) }); }
    catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  },
  openOrders() { wx.navigateTo({ url:'/pages/orders/index' }); },
  openInquiries() { wx.navigateTo({ url:'/pages/inquiries/index' }); },
  openAfterSales() { wx.navigateTo({ url:'/pages/after-sales/index' }); },
  logout() {
    const app=getApp<IAppOption>();
    request({ path:'/api/miniprogram/v1/auth/logout',method:'POST' }).catch(()=>{});
    app.clearSession();
    wx.reLaunch({ url:'/pages/login/index' });
  }
});
