import { request,showError } from '../../utils/request';
import { cancellationText,countryInfo,deadlineText,dimensionSummary,dimensionWeightState,formatDate,money,orderState,platformDimensionSourceNote,reputationReasonText } from '../../utils/format';

Page({
  data:{
    loading:true,dimensionRefreshing:false,order:null as any,displayOrderId:'',loadedOnce:false,orderSyncing:false,
    fulfillmentOptionsLoading:false,fulfillmentSubmitting:false,fulfillmentResubmit:false,fulfillmentExpressEditing:false,fulfillmentExpressUpdating:false,
    warehouses:[] as any[],carriers:[] as any[],allCarriers:[] as any[],shopeexCarriers:[] as any[],warehouseNames:[] as string[],carrierNames:[] as string[],
    warehouseIndex:0,carrierIndex:0,
    fulfillmentForm:{ trackingNumber:'',quantity:'1',remark:'' }
  },
  async onLoad(options:Record<string,string>) {
    if (!options.id) {
      wx.navigateBack();
      return;
    }
    this.setData({ displayOrderId:options.id });
    await Promise.all([this.loadOrder(),this.loadFulfillmentOptions()]);
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
        payoutText:money(raw.netAmountUsd,'USD'),costText:money(raw.productCost || 0,'CNY'),
        profitText:money(raw.profitCny,'CNY'),
        profitClass:raw.profitCny === null || raw.profitCny === undefined
          ? 'muted'
          : Number(raw.profitCny) < 0 ? 'danger' : 'success',
        payoutHint:raw.payoutIsOfficial ? '官方实际净回款' : '官方净回款待获取',
        deadlineText:deadlineText(raw),
        cancellationText:cancellationText(raw.cancellationReason),
        sellerDimensionText:dimensionSummary(dimensionSnapshot,'seller'),
        platformDimensionText:dimensionSummary(dimensionSnapshot,'platform'),
        platformDimensionNote:platformDimensionSourceNote(dimensionSnapshot),
        sellerWeightHint:dimensionState.sellerHint,
        sellerWeightHintClass:dimensionState.sellerHintClass,
        weightAnomaly:dimensionState.weightAnomaly,
        dimensionsAvailable:Boolean(raw.dimensionsOriginal?.available || raw.dimensionsLatest?.available),
        reputationReasonText:reputationReasonText(raw.reputationReason),
        canSubmitFulfillment:raw.status !== 'cancelled'
          && Number(raw.refundAmount || 0) <= 0
          && raw.shipmentStatus === 'ready_to_ship',
        canResubmitFulfillment:raw.status !== 'cancelled'
          && Number(raw.refundAmount || 0) <= 0
          && ['success','failed'].includes(String(raw.fulfillmentSubmission?.status || '')),
        totalQuantity:products.reduce((total:number,item:any)=>total + Math.max(1,Number(item.quantity || 1)),0) || 1
      } });
      if (!raw.fulfillmentSubmission) {
        const totalQuantity=products.reduce((total:number,item:any)=>total + Math.max(1,Number(item.quantity || 1)),0) || 1;
        this.setData({ 'fulfillmentForm.quantity':String(totalQuantity) });
      }
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  },
  async loadFulfillmentOptions() {
    if (this.data.fulfillmentOptionsLoading) return;
    this.setData({ fulfillmentOptionsLoading:true });
    try {
      const data=await request<any>({ path:'/api/miniprogram/v1/fulfillment-options' });
      const warehouses=(data.connectors || []).filter((item:any)=>item.enabled !== false);
      const allCarriers=(data.carriers || []).filter((item:any)=>item.enabled !== false);
      const shopeexCarriers=(data.shopeexCarriers || []).filter((item:any)=>item.code && item.name);
      this.setData({
        warehouses,allCarriers,shopeexCarriers,
        warehouseNames:warehouses.map((item:any)=>item.warehouseCode ? `${item.name}（${item.warehouseCode}）` : item.name),
        warehouseIndex:0
      });
      this.refreshCarrierChoices(0);
    } catch (error) { showError(error); }
    finally { this.setData({ fulfillmentOptionsLoading:false }); }
  },
  onWarehouseChange(event:WechatMiniprogram.PickerChange) {
    const warehouseIndex=Number(event.detail.value || 0);
    this.setData({ warehouseIndex },()=>this.refreshCarrierChoices(warehouseIndex));
  },
  refreshCarrierChoices(warehouseIndex:number,preferredCarrier='') {
    const warehouse=this.data.warehouses[warehouseIndex];
    const carriers=warehouse?.provider === 'shopeex' ? this.data.shopeexCarriers : this.data.allCarriers;
    this.setData({
      carriers,
      carrierNames:carriers.map((item:any)=>warehouse?.provider === 'shopeex' ? `${item.name}（${item.code}）` : item.name),
      carrierIndex:Math.max(0,carriers.findIndex((item:any)=>item.name === preferredCarrier))
    });
  },
  onCarrierChange(event:WechatMiniprogram.PickerChange) {
    this.setData({ carrierIndex:Number(event.detail.value || 0) });
  },
  onFulfillmentInput(event:WechatMiniprogram.Input) {
    const field=String(event.currentTarget.dataset.field || '');
    if (!['trackingNumber','quantity','remark'].includes(field)) return;
    this.setData({ [`fulfillmentForm.${field}`]:event.detail.value });
  },
  async submitFulfillment() {
    const order=this.data.order;
    const resubmitting=Boolean(this.data.fulfillmentResubmit);
    const existingStatus=String(order?.fulfillmentSubmission?.status || '');
    const canSubmit=Boolean(order?.canSubmitFulfillment && !order.fulfillmentSubmission);
    const canResubmit=Boolean(resubmitting && order?.canResubmitFulfillment && ['success','failed'].includes(existingStatus));
    if (!canSubmit && !canResubmit) return;
    const warehouse=this.data.warehouses[this.data.warehouseIndex];
    const carrier=this.data.carriers[this.data.carrierIndex];
    const trackingNumber=String(this.data.fulfillmentForm.trackingNumber || '').trim();
    const quantity=Number(this.data.fulfillmentForm.quantity);
    const remark=String(this.data.fulfillmentForm.remark || '').trim();
    if (!warehouse) return wx.showToast({ title:'请选择仓库',icon:'none' });
    if (!carrier) return wx.showToast({ title:'请选择快递公司',icon:'none' });
    if (!trackingNumber) return wx.showToast({ title:'请填写快递单号',icon:'none' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > Number(order.totalQuantity || 1)) {
      return wx.showToast({ title:`发货数量应为1至${order.totalQuantity}`,icon:'none' });
    }
    if (remark.length > 500) return wx.showToast({ title:'备注不能超过500字',icon:'none' });
    const confirmation=await new Promise<boolean>(resolve=>wx.showModal({
      title:'确认提交代贴单',
      content:`${warehouse.name} · ${carrier.name}\n快递单号：${trackingNumber}\n发货数量：${quantity}`,
      success:result=>resolve(Boolean(result.confirm)),fail:()=>resolve(false)
    }));
    if (!confirmation) return;
    const orderId=String(order.displayOrderId || order.orderId);
    this.setData({ fulfillmentSubmitting:true });
    wx.showLoading({ title:'正在提交',mask:true });
    try {
      await request<any>({
        path:'/api/miniprogram/v1/fulfillment/submit',method:'POST',timeout:60000,
        data:{
          orderIds:[orderId],warehouseId:warehouse.id,carrier:carrier.name,
          carrierCode:warehouse.provider === 'shopeex' ? String(carrier.code || '') : '',serviceIds:[],
          trackingByOrder:{ [orderId]:trackingNumber },
          quantityByOrder:{ [orderId]:quantity },
          remarkByOrder:{ [orderId]:remark },
          resubmitOrderIds:resubmitting ? [orderId] : []
        }
      });
      this.setData({ fulfillmentResubmit:false });
      await this.loadOrder();
      wx.showToast({ title:'代贴单已提交',icon:'success' });
    } catch (error) { showError(error); }
    finally { wx.hideLoading();this.setData({ fulfillmentSubmitting:false }); }
  },
  startFulfillmentResubmit() {
    const order=this.data.order;
    const submission=order?.fulfillmentSubmission;
    if (!order?.canResubmitFulfillment || !submission || !['success','failed'].includes(String(submission.status || ''))) return;
    const warehouseIndex=Math.max(0,this.data.warehouses.findIndex((item:any)=>
      String(item.id) === String(submission.warehouseId || '') || item.name === submission.warehouseName));
    this.setData({
      fulfillmentResubmit:true,fulfillmentExpressEditing:false,warehouseIndex,
      fulfillmentForm:{
        trackingNumber:String(submission.trackingNumber || ''),
        quantity:String(submission.shippingQuantity || order.totalQuantity || 1),
        remark:String(submission.shippingRemark || '')
      }
    },()=>this.refreshCarrierChoices(warehouseIndex,String(submission.carrier || '')));
  },
  cancelFulfillmentResubmit() { this.setData({ fulfillmentResubmit:false }); },
  async syncOrder() {
    const order=this.data.order;
    const orderId=String(order?.displayOrderId || order?.orderId || '');
    const storeId=String(order?.storeId || '');
    if (this.data.orderSyncing || !orderId || !storeId) return wx.showToast({ title:'未找到订单所属店铺',icon:'none' });
    this.setData({ orderSyncing:true });
    wx.showLoading({ title:'正在同步',mask:true });
    try {
      await request<any>({
        path:`/api/miniprogram/v1/orders/${encodeURIComponent(orderId)}/sync`,method:'POST',timeout:60000,
        data:{ storeId }
      });
      await this.loadOrder();
      wx.showToast({ title:'订单已同步',icon:'success' });
    } catch (error) { showError(error); }
    finally { wx.hideLoading();this.setData({ orderSyncing:false }); }
  },
  startExpressUpdate() {
    const submission=this.data.order?.fulfillmentSubmission;
    if (!submission || submission.status !== 'success' || submission.provider !== 'yeeke') return;
    const carrierIndex=Math.max(0,this.data.carriers.findIndex((item:any)=>item.name === submission.carrier));
    this.setData({
      fulfillmentExpressEditing:true,carrierIndex,
      fulfillmentForm:{
        trackingNumber:String(submission.trackingNumber || ''),
        quantity:String(submission.shippingQuantity || this.data.order?.totalQuantity || 1),
        remark:String(submission.shippingRemark || '')
      }
    });
  },
  cancelExpressUpdate() { this.setData({ fulfillmentExpressEditing:false }); },
  async submitExpressUpdate() {
    const order=this.data.order;
    const submission=order?.fulfillmentSubmission;
    const carrier=this.data.carriers[this.data.carrierIndex];
    const trackingNumber=String(this.data.fulfillmentForm.trackingNumber || '').trim();
    const shippingRemark=String(this.data.fulfillmentForm.remark || '').trim();
    if (!submission || submission.status !== 'success' || submission.provider !== 'yeeke') return;
    if (!carrier) return wx.showToast({ title:'请选择快递公司',icon:'none' });
    if (!trackingNumber) return wx.showToast({ title:'请填写新的快递单号',icon:'none' });
    if (shippingRemark.length > 500) return wx.showToast({ title:'备注不能超过500字',icon:'none' });
    if (trackingNumber === String(submission.trackingNumber || '') && carrier.name === submission.carrier && shippingRemark === String(submission.shippingRemark || '')) {
      return wx.showToast({ title:'快递信息没有变化',icon:'none' });
    }
    const confirmed=await new Promise<boolean>(resolve=>wx.showModal({
      title:'确认修改快递号',
      content:'修改会同步到 Yeeke 原订单，不会创建新订单。',
      success:result=>resolve(Boolean(result.confirm)),fail:()=>resolve(false)
    }));
    if (!confirmed) return;
    this.setData({ fulfillmentExpressUpdating:true });
    wx.showLoading({ title:'正在同步修改',mask:true });
    try {
      await request<any>({
        path:'/api/miniprogram/v1/fulfillment/update-express',method:'POST',timeout:60000,
        data:{
          orderId:String(order.displayOrderId || order.orderId),carrier:carrier.name,trackingNumber,shippingRemark
        }
      });
      this.setData({ fulfillmentExpressEditing:false });
      await this.loadOrder();
      wx.showToast({ title:'快递号已修改',icon:'success' });
    } catch (error) { showError(error); }
    finally { wx.hideLoading();this.setData({ fulfillmentExpressUpdating:false }); }
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
