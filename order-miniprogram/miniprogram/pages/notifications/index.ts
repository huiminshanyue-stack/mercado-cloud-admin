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

const defaultPreferences:Preferences={
  enabled:true,newOrder:true,cancelled:true,deadline:true,refund:true,buyerInquiry:true,afterSales:true
};

Page({
  data:{
    loading:false,
    saving:false,
    preferences:{ ...defaultPreferences },
    binding:{ followers:0,subscribed:0,bound:0 } as BindingStatus
  },
  onShow() { this.loadSettings(); },
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
  }
});
