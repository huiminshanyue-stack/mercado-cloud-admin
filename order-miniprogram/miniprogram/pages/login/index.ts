import { request,showError } from '../../utils/request';

Page({
  data: { loading:false,wechatEnabled:false,username:'',password:'' },
  async onLoad() {
    const app = getApp<IAppOption>();
    if (app.globalData.token) {
      try {
        const me = await request<any>({ path:'/api/miniprogram/v1/me' });
        if (me.bound) {
          wx.reLaunch({ url:'/pages/orders/index' });
          return;
        }
      } catch (_) { app.clearSession(); }
    }
    try {
      const config = await request<any>({ path:'/api/miniprogram/v1/config',authenticated:false });
      this.setData({ wechatEnabled:Boolean(config.wechatLoginEnabled) });
    } catch (error) { showError(error); }
  },
  onUsername(event:WechatMiniprogram.Input) { this.setData({ username:event.detail.value.trim() }); },
  onPassword(event:WechatMiniprogram.Input) { this.setData({ password:event.detail.value }); },
  async loginWithWechat() {
    if (this.data.loading) return;
    this.setData({ loading:true });
    try {
      const login = await new Promise<WechatMiniprogram.LoginSuccessCallbackResult>((resolve,reject) => wx.login({ success:resolve,fail:reject }));
      const result = await request<any>({ path:'/api/miniprogram/v1/auth/wechat-login',method:'POST',data:{ code:login.code },authenticated:false });
      getApp<IAppOption>().setSession(result.token,result.user || null);
      wx.reLaunch({ url:result.bound ? '/pages/orders/index' : '/pages/bind/index' });
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  },
  async loginWithErp() {
    if (this.data.loading) return;
    if (!this.data.username || !this.data.password) return wx.showToast({ title:'请输入ERP账号和密码',icon:'none' });
    this.setData({ loading:true });
    try {
      const result = await request<any>({ path:'/api/auth/login',method:'POST',data:{ username:this.data.username,password:this.data.password },authenticated:false });
      getApp<IAppOption>().setSession(result.token,result.user);
      await request<any>({ path:'/api/miniprogram/v1/me' });
      wx.reLaunch({ url:'/pages/orders/index' });
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  }
});
