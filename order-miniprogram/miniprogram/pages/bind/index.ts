import { request,showError } from '../../utils/request';

Page({
  data:{ username:'',password:'',loading:false },
  onUsername(event:WechatMiniprogram.Input) { this.setData({ username:event.detail.value.trim() }); },
  onPassword(event:WechatMiniprogram.Input) { this.setData({ password:event.detail.value }); },
  async bindAccount() {
    if (!this.data.username || !this.data.password) return wx.showToast({ title:'请输入ERP账号和密码',icon:'none' });
    this.setData({ loading:true });
    try {
      const result = await request<any>({ path:'/api/miniprogram/v1/auth/bind',method:'POST',data:{ username:this.data.username,password:this.data.password } });
      const app = getApp<IAppOption>();
      app.setSession(app.globalData.token,result.user);
      wx.reLaunch({ url:'/pages/home/index' });
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  }
});
