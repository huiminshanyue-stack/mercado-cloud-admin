import { request,showError } from '../../utils/request';
import { cancellationText,countryInfo,deadlineText,dimensionSummary,formatDate,money,onlineDeadlineText,orderState,reputationReasonText } from '../../utils/format';

Page({
  data:{ loading:true,order:null as any },
  async onLoad(options:Record<string,string>) {
    if (!options.id) {
      wx.navigateBack();
      return;
    }
    try {
      const raw = await request<any>({ path:`/api/miniprogram/v1/orders/${encodeURIComponent(options.id)}` });
      const country = countryInfo(raw.country);
      const products=(raw.items || []).map((product:any) => {
        const item=product.item || {};
        return {
          title:item.title || '商品信息待获取',image:item.picture_url || item.thumbnail || '',itemId:item.id || '-',
          sku:item.seller_sku || item.seller_custom_field || item.sku || '-',quantity:product.quantity || 1
        };
      });
      this.setData({ order:{
        ...raw,displayOrderId:raw.displayOrderId || raw.orderId,stateText:orderState(raw),countryName:country.name,countryFlag:country.flag,
        dateText:formatDate(raw.dateCreated),products,
        grossText:money(raw.grossAmountUsd ?? raw.paidAmount,'USD'),saleFeeText:money(raw.salesCommissionTotalSigned ?? raw.saleFee,'USD'),
        shippingFeeText:money(raw.shippingFeeSigned ?? raw.shippingFee,'USD'),refundText:money(raw.refundAmountUsd ?? raw.refundAmount,'USD'),
        payoutText:money(raw.netAmountUsd,'USD'),costText:Number(raw.productCost || 0).toFixed(2),
        payoutHint:raw.payoutIsOfficial ? '官方实际净回款' : '官方净回款待获取',
        deadlineText:deadlineText(raw),onlineText:onlineDeadlineText(raw),
        cancellationText:cancellationText(raw.cancellationReason),
        originalDimensionText:dimensionSummary(raw.dimensionsOriginal,'original'),
        latestDimensionText:dimensionSummary(raw.dimensionsLatest,'latest'),
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
  }
});
