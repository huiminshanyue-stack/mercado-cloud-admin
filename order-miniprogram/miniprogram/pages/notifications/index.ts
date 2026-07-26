import { request,showError } from '../../utils/request';

interface Preferences {
  enabled:boolean;
  newOrder:boolean;
  cancelled:boolean;
  deadline:boolean;
  refund:boolean;
  buyerInquiry:boolean;
  afterSales:boolean;
}

interface BindingStatus { followers:number; subscribed:number; bound:number; }
interface BindingRefreshResult { status:'bound'|'not_following'|'unionid_unavailable';binding:BindingStatus;message:string; }

const defaultPreferences:Preferences={
  enabled:true,newOrder:true,cancelled:true,deadline:true,refund:true,buyerInquiry:true,afterSales:true
};

Page({
  data:{
    loading:false,
    saving:false,
    detecting:false,
    detectAfterReturn:false,
    preferences:{ ...defaultPreferences },
    binding:{ followers:0,subscribed:0,bound:0 } as BindingStatus
  },
  onShow() {
    if (this.data.detectAfterReturn) {
      this.setData({ detectAfterReturn:false });
      this.detectAndBind();
      return;
    }
    this.loadSettings();
  },
  async onPullDownRefresh() { await this.loadSettings(); wx.stopPullDownRefresh(); },
  async loadSettings() {
    if (this.data.loading) return;
    this.setData({ loading:true });
    try {
      const result=await request<{ preferences:Preferences;binding:BindingStatus }>({ path:'/api/miniprogram/v1/notification-preferences' });
      this.setData({ preferences:{ ...defaultPreferences,...result.preferences },binding:result.binding || { followers:0,subscribed:0,bound:0 } });
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  },
  async onSwitch(event:WechatMiniprogram.SwitchChange) {
    if (this.data.saving) return;
    const key=String(event.currentTarget.dataset.key || '') as keyof Preferences;
    if (!Object.prototype.hasOwnProperty.call(defaultPreferences,key)) return;
    const previous={ ...this.data.preferences };
    const next={ ...previous,[key]:Boolean(event.detail.value) };
    this.setData({ preferences:next,saving:true });
    try {
      const saved=await request<Preferences>({ path:'/api/miniprogram/v1/notification-preferences',method:'PUT',data:next });
      this.setData({ preferences:{ ...defaultPreferences,...saved } });
      wx.showToast({ title:'已保存',icon:'success',duration:1000 });
    } catch (error) {
      this.setData({ preferences:previous });
      showError(error);
    } finally { this.setData({ saving:false }); }
  },
  openOfficialAccount() {
    this.setData({ detectAfterReturn:true });
    wx.openOfficialAccountProfile({
      username:'gh_a43672ed7223',
      fail:() => {
        this.setData({ detectAfterReturn:false });
        wx.showModal({ title:'无法打开公众号',content:'请在微信中搜索并关注“山月跨境”，然后返回此页点击“检测并绑定”。',showCancel:false });
      }
    });
  },
  async detectAndBind() {
    if (this.data.detecting) return;
    this.setData({ detecting:true });
    try {
      const login=await new Promise<WechatMiniprogram.LoginSuccessCallbackResult>((resolve,reject) => {
        wx.login({ success:resolve,fail:reject });
      });
      if (!login.code) throw new Error('微信未返回登录凭证，请稍后重试');
      const result=await request<BindingRefreshResult>({
        path:'/api/miniprogram/v1/official-account-binding/refresh',method:'POST',data:{ code:login.code },timeout:45000
      });
      this.setData({ binding:result.binding || { followers:0,subscribed:0,bound:0 } });
      if (result.status==='bound') wx.showToast({ title:'公众号绑定成功',icon:'success',duration:1800 });
      else wx.showModal({ title:'暂未绑定成功',content:result.message,showCancel:false });
    } catch (error) {
      const message=error instanceof Error ? error.message : '检测失败，请稍后重试';
      wx.showModal({ title:'检测失败',content:message,showCancel:false });
    } finally { this.setData({ detecting:false }); }
  }
});
