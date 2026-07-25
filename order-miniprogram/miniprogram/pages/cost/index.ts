import { request,showError } from '../../utils/request';

Page({
  data:{ loading:true,saving:false,displayOrderId:'',orderId:'',cost:'0.00',note:'',productTitle:'',productImage:'' },
  async onLoad(options:Record<string,string | undefined>) {
    const id=String(options.id || '');
    if (!id) { wx.navigateBack(); return; }
    this.setData({ displayOrderId:id });
    try {
      const order=await request<any>({ path:`/api/miniprogram/v1/orders/${encodeURIComponent(id)}` });
      const item=order.items?.[0]?.item || {};
      this.setData({ orderId:String(order.orderId),cost:String(Number(order.productCost || 0).toFixed(2)),note:order.costNote || '',productTitle:item.title || '商品信息待获取',productImage:item.picture_url || item.thumbnail || '' });
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  },
  onCost(event:WechatMiniprogram.Input) { this.setData({ cost:event.detail.value.trim() }); },
  onNote(event:WechatMiniprogram.TextareaInput) { this.setData({ note:event.detail.value }); },
  async saveCost() {
    if (this.data.saving) return;
    const text=String(this.data.cost).trim();
    const cost=Number(text);
    if (!text || !Number.isFinite(cost)) { wx.showToast({ title:'请输入有效成本，可填负数',icon:'none' }); return; }
    this.setData({ saving:true });
    try {
      await request({ path:`/api/miniprogram/v1/orders/${encodeURIComponent(this.data.orderId)}/cost`,method:'PATCH',data:{ cost,note:this.data.note } });
      wx.showToast({ title:'成本已同步到服务器',icon:'success' });
      setTimeout(()=>wx.navigateBack(),900);
    } catch (error) { showError(error); }
    finally { this.setData({ saving:false }); }
  }
});
