import { request,showError } from '../../utils/request';
import { cancellationText,countryInfo,deadlineText,dimensionSummary,dimensionWeightState,formatDate,money,onlineDeadlineText,orderState,reputationReasonText } from '../../utils/format';

Page({
  data:{ loading:true,dimensionRefreshing:false,order:null as any,displayOrderId:'',loadedOnce:false },
  async onLoad(options:Record<string,string>) {
    if (!options.id) {
      wx.navigateBack();
      return;
    }
    this.setData({ displayOrderId:options.id });
    await this.loadOrder();
    this.setData({ loadedOnce:true });
  },
  onShow() { if (this.data.loadedOnce) this.loadOrder(); },
  async loadOrder() {
    this.setData({ loading:true });
    try {
      const raw = await request<any>({ path:`/api/miniprogram/v1/orders/${encodeURIComponent(this.data.displayOrderId)}` });
      const country = countryInfo(raw.country);
      const products=(raw.items || []).map((product:any,index:number) => {
        const item=product.item || {};
        return {
          title:item.title || '商品信息待获取',image:item.picture_url || item.thumbnail || '',itemId:item.id || '-',
          sku:item.seller_sku || item.seller_custom_field || item.sku || '-',
          color:item.colorNameZh || item.color_name_zh || '-',quantity:product.quantity || 1,
          productKey:`${item.id || 'item'}:${item.variation_id || item.seller_sku || item.seller_custom_field || 'variation'}:${index}`
        };
      });
      const dimensionSnapshot=raw.dimensionsLatest?.available ? raw.dimensionsLatest : raw.dimensionsOriginal;
      const dimensionState=dimensionWeightState(raw.items || [],dimensionSnapshot);
      this.setData({ order:{
        ...raw,displayOrderId:raw.displayOrderId || raw.orderId,stateText:orderState(raw),countryName:country.name,countryFlag:country.flag,
        dateText:formatDate(raw.dateCreated),products,
        grossText:money(raw.grossAmountUsd ?? raw.paidAmount,'USD'),saleFeeText:money(raw.salesCommissionTotalSigned ?? raw.saleFee,'USD'),
        shippingFeeText:money(raw.shippingFeeSigned ?? raw.shippingFee,'USD'),refundText:money(raw.refundAmountUsd ?? raw.refundAmount,'USD'),
        payoutText:money(raw.netAmountUsd,'USD'),costText:Number(raw.productCost || 0).toFixed(2),
        payoutHint:raw.payoutIsOfficial ? '官方实际净回款' : '官方净回款待获取',
        deadlineText:deadlineText(raw),onlineText:onlineDeadlineText(raw),
        cancellationText:cancellationText(raw.cancellationReason),
        sellerDimensionText:dimensionSummary(dimensionSnapshot,'seller'),
        platformDimensionText:dimensionSummary(dimensionSnapshot,'platform'),
        sellerWeightHint:dimensionState.sellerHint,
        sellerWeightHintClass:dimensionState.sellerHintClass,
        weightAnomaly:dimensionState.weightAnomaly,
        dimensionsAvailable:Boolean(raw.dimensionsOriginal?.available || raw.dimensionsLatest?.available),
        reputationReasonText:reputationReasonText(raw.reputationReason)
      } });
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  },
  previewImage(event:WechatMiniprogram.TouchEvent) {
    const images=(this.data.order?.products || []).map((item:any)=>item.image).filter(Boolean);
    const current=this.data.order?.products?.[Number(event.currentTarget.dataset.index || 0)]?.image;
    if (current) wx.previewImage({ current,urls:images });
  },
  openCost() {
    wx.navigateTo({ url:`/pages/cost/index?id=${encodeURIComponent(this.data.order.displayOrderId)}` });
  },
  async refreshDimensions() {
    if (this.data.dimensionRefreshing || !this.data.displayOrderId) return;
    this.setData({ dimensionRefreshing:true });
    wx.showLoading({ title:'正在获取',mask:true });
    let updated=false;
    let failure:unknown=null;
    try {
      await request<any>({
        path:`/api/miniprogram/v1/orders/${encodeURIComponent(this.data.displayOrderId)}/dimensions/refresh`,
        method:'POST',
        timeout:60000
      });
      await this.loadOrder();
      updated=true;
    } catch (error) { failure=error; }
    finally {
      wx.hideLoading();
      this.setData({ dimensionRefreshing:false });
    }
    if (failure) showError(failure);
    else if (updated) wx.showToast({ title:'尺寸重量已更新',icon:'success' });
  }
});
