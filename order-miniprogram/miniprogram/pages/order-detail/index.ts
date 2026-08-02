import { request,showError } from '../../utils/request';
import { cancellationText,countryInfo,deadlineText,dimensionSummary,dimensionWeightState,formatDate,money,orderState,platformDimensionSourceNote,reputationReasonText } from '../../utils/format';

Page({
  data:{
    loading:true,dimensionRefreshing:false,order:null as any,displayOrderId:'',loadedOnce:false,orderSyncing:false,
    fulfillmentOptionsLoading:false,fulfillmentStockLoading:false,fulfillmentSubmitting:false,fulfillmentResubmit:false,fulfillmentExpressEditing:false,fulfillmentExpressUpdating:false,
    warehouses:[] as any[],carriers:[] as any[],allCarriers:[] as any[],shopeexCarriers:[] as any[],warehouseNames:[] as string[],carrierNames:[] as string[],
    warehouseIndex:0,carrierIndex:0,fulfillmentMode:'express',fulfillmentModeIndex:0,
    fulfillmentModeNames:['国内快递发仓','仓库库存发货'],fulfillmentStockRecords:[] as any[],stockLines:[] as any[],
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
        canUpdateFulfillmentExpress:raw.fulfillmentSubmission?.fulfillmentMode !== 'stock'
          && raw.fulfillmentSubmission?.status === 'success'
          && raw.fulfillmentSubmission?.provider === 'yeeke',
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
    this.setData({ warehouseIndex },()=>{
      this.refreshCarrierChoices(warehouseIndex);
      if (this.data.fulfillmentMode === 'stock') void this.loadFulfillmentStock();
    });
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
  onFulfillmentModeChange(event:WechatMiniprogram.PickerChange) {
    const fulfillmentModeIndex=Number(event.detail.value || 0);
    const fulfillmentMode=fulfillmentModeIndex === 1 ? 'stock' : 'express';
    const warehouse=this.data.warehouses[this.data.warehouseIndex];
    if (fulfillmentMode === 'stock' && !['yeeke','shopeex'].includes(String(warehouse?.provider || ''))) {
      this.setData({ fulfillmentMode:'express',fulfillmentModeIndex:0,fulfillmentStockRecords:[],stockLines:[] });
      wx.showToast({ title:'当前仓库暂不支持库存发货',icon:'none' });
      return;
    }
    this.setData({ fulfillmentMode,fulfillmentModeIndex,fulfillmentStockRecords:[],stockLines:[] },()=>{
      if (fulfillmentMode === 'stock') void this.loadFulfillmentStock();
    });
  },
  async loadFulfillmentStock() {
    const warehouse=this.data.warehouses[this.data.warehouseIndex];
    if (!warehouse || this.data.fulfillmentMode !== 'stock' || this.data.fulfillmentStockLoading) return;
    this.setData({ fulfillmentStockLoading:true,fulfillmentStockRecords:[],stockLines:[] });
    try {
      const data=await request<any>({
        path:`/api/miniprogram/v1/warehouse-inventory/fulfillable?warehouseId=${encodeURIComponent(String(warehouse.id))}`,
        timeout:60000
      });
      const records=(data.records || []).filter((item:any)=>Number(item.availableQuantity || 0) > 0);
      const stockLines=records.length ? (this.data.order?.products || []).map((product:any,index:number) => {
        const sku=String(product.sku === '-' ? '' : product.sku || '').trim();
        const stockOptions=[...records].sort((left:any,right:any) => {
          const leftExact=sku && String(left.sku || '').toUpperCase() === sku.toUpperCase() ? 1 : 0;
          const rightExact=sku && String(right.sku || '').toUpperCase() === sku.toUpperCase() ? 1 : 0;
          return rightExact-leftExact;
        });
        const exactIndex=stockOptions.findIndex((item:any)=>sku && String(item.sku || '').toUpperCase() === sku.toUpperCase());
        return {
          key:product.productKey || `${sku || 'line'}:${index}`,title:product.title,sku,
          orderedQuantity:Math.max(1,Number(product.quantity || 1)),stockOptions,
          stockNames:stockOptions.map((item:any)=>{
            const exact=sku && String(item.sku || '').toUpperCase() === sku.toUpperCase();
            return `${exact ? '同SKU' : '需确认'} · ${item.productName || item.sku || '库存商品'} · SKU ${item.sku || '-'} · 可发 ${item.availableQuantity}${item.warehouseLocation ? ` · 库位 ${item.warehouseLocation}` : ''}`;
          }),
          stockIndex:Math.max(0,exactIndex),quantity:String(Math.max(1,Number(product.quantity || 1)))
        };
      }) : [];
      this.setData({ fulfillmentStockRecords:records,stockLines });
    } catch (error) { showError(error); }
    finally { this.setData({ fulfillmentStockLoading:false }); }
  },
  onStockSelectionChange(event:WechatMiniprogram.PickerChange) {
    const lineIndex=Number(event.currentTarget.dataset.lineIndex || 0);
    this.setData({ [`stockLines[${lineIndex}].stockIndex`]:Number(event.detail.value || 0) });
  },
  onStockQuantityInput(event:WechatMiniprogram.Input) {
    const lineIndex=Number(event.currentTarget.dataset.lineIndex || 0);
    this.setData({ [`stockLines[${lineIndex}].quantity`]:event.detail.value });
  },
  buildStockByOrder(orderId:string) {
    const allocations:any[]=[];
    const mismatches:string[]=[];
    const used=new Map<string,number>();
    for (const line of this.data.stockLines || []) {
      const sku=String(line.sku || '').trim();
      if (!sku) throw new Error('订单商品缺少 SKU，不能使用库存发货');
      const stock=line.stockOptions?.[Number(line.stockIndex || 0)];
      if (!stock) throw new Error(`SKU ${sku} 尚未选择可发库存`);
      const quantity=Number(line.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > Number(line.orderedQuantity || 1)) {
        throw new Error(`SKU ${sku} 发货数量必须是 1 至 ${line.orderedQuantity}`);
      }
      const stockId=String(stock.remoteProductId || '');
      const alreadyUsed=used.get(stockId) || 0;
      if (!stockId || alreadyUsed+quantity > Number(stock.availableQuantity || 0)) {
        throw new Error(`SKU ${sku} 所选库存不足`);
      }
      used.set(stockId,alreadyUsed+quantity);
      const stockSku=String(stock.sku || '');
      const skuMismatch=stockSku.toUpperCase() !== sku.toUpperCase();
      if (skuMismatch) mismatches.push(`${sku} → ${stockSku || '未设置'}`);
      allocations.push({ sku,stockSku,skuMismatchConfirmed:skuMismatch,remoteProductId:stockId,quantity });
    }
    if (!allocations.length) throw new Error('当前订单尚未选择可发库存');
    return { stockByOrder:{ [orderId]:allocations },mismatches,
      summary:allocations.map(item=>`${item.stockSku || item.sku} ×${item.quantity}`).join('；') };
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
    const stockMode=this.data.fulfillmentMode === 'stock';
    const trackingNumber=String(this.data.fulfillmentForm.trackingNumber || '').trim();
    const quantity=Number(this.data.fulfillmentForm.quantity);
    const remark=String(this.data.fulfillmentForm.remark || '').trim();
    if (!warehouse) return wx.showToast({ title:'请选择仓库',icon:'none' });
    if (stockMode && !['yeeke','shopeex'].includes(String(warehouse.provider || ''))) return wx.showToast({ title:'当前仓库暂不支持库存发货',icon:'none' });
    if (!stockMode && !carrier) return wx.showToast({ title:'请选择快递公司',icon:'none' });
    if (!stockMode && !trackingNumber) return wx.showToast({ title:'请填写快递单号',icon:'none' });
    if (!stockMode && (!Number.isInteger(quantity) || quantity < 1 || quantity > Number(order.totalQuantity || 1))) {
      return wx.showToast({ title:`发货数量应为1至${order.totalQuantity}`,icon:'none' });
    }
    if (remark.length > 500) return wx.showToast({ title:'备注不能超过500字',icon:'none' });
    const orderId=String(order.displayOrderId || order.orderId);
    let stockByOrder:Record<string,any[]>={};
    let stockSummary='';
    if (stockMode) {
      try {
        const stockRequest=this.buildStockByOrder(orderId);
        stockByOrder=stockRequest.stockByOrder;
        stockSummary=stockRequest.summary;
        if (stockRequest.mismatches.length) {
          const mismatchConfirmed=await new Promise<boolean>(resolve=>wx.showModal({
            title:'确认库存商品',
            content:`以下库存 SKU 与订单 SKU 不一致：\n${stockRequest.mismatches.join('\n')}\n请确认它们确实是同一商品。`,
            confirmText:'确认同一商品',success:result=>resolve(Boolean(result.confirm)),fail:()=>resolve(false)
          }));
          if (!mismatchConfirmed) return;
        }
      } catch (error) { showError(error);return; }
    }
    const confirmation=await new Promise<boolean>(resolve=>wx.showModal({
      title:'确认提交代贴单',
      content:stockMode
        ? `${warehouse.name} · 仓库库存发货\n${stockSummary}`
        : `${warehouse.name} · ${carrier.name}\n快递单号：${trackingNumber}\n发货数量：${quantity}`,
      success:result=>resolve(Boolean(result.confirm)),fail:()=>resolve(false)
    }));
    if (!confirmation) return;
    this.setData({ fulfillmentSubmitting:true });
    wx.showLoading({ title:'正在提交',mask:true });
    try {
      await request<any>({
        path:'/api/miniprogram/v1/fulfillment/submit',method:'POST',timeout:60000,
        data:{
          orderIds:[orderId],warehouseId:warehouse.id,fulfillmentMode:stockMode ? 'stock' : 'express',stockModeConfirmed:stockMode,
          carrier:stockMode ? '' : carrier.name,
          carrierCode:!stockMode && warehouse.provider === 'shopeex' ? String(carrier.code || '') : '',serviceIds:[],
          trackingByOrder:stockMode ? {} : { [orderId]:trackingNumber },
          quantityByOrder:stockMode ? {} : { [orderId]:quantity },stockByOrder,
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
      fulfillmentResubmit:true,fulfillmentExpressEditing:false,warehouseIndex,fulfillmentMode:'express',fulfillmentModeIndex:0,
      fulfillmentStockRecords:[],stockLines:[],
      fulfillmentForm:{
        trackingNumber:submission.fulfillmentMode === 'stock' ? '' : String(submission.trackingNumber || ''),
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
    if (!submission || submission.fulfillmentMode === 'stock' || submission.status !== 'success' || submission.provider !== 'yeeke') return;
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
      content:'修改会同步到原仓库订单，不会创建新订单。',
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
