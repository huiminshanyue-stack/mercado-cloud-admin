import { request,showError } from '../../utils/request';
import { isSellerMessage,messageList } from '../../utils/messages';

function decodeRouteValue(value:string | undefined) {
  let decoded=String(value || '');
  for (let index=0;index<2 && /%[0-9a-f]{2}/i.test(decoded);index+=1) {
    try { decoded=decodeURIComponent(decoded); }
    catch (_) { break; }
  }
  return decoded;
}

Page({
  data:{ orderId:'',storeId:'',orderNo:'',threadLabel:'订单',messages:[] as any[],loading:true,translating:false,sending:false,chineseText:'',englishText:'' },
  async onLoad(options:Record<string,string | undefined>) {
    const orderId=decodeRouteValue(options.orderId);
    const isProductQuestion=orderId.startsWith('question:');
    const routeOrderNo=decodeRouteValue(options.orderNo || options.orderId);
    const orderNo=isProductQuestion ? routeOrderNo.replace(/^售前问题\s*/,'') : routeOrderNo;
    this.setData({ orderId,storeId:decodeRouteValue(options.storeId),orderNo,threadLabel:isProductQuestion ? '售前问题' : '订单' });
    await this.loadMessages();
  },
  async loadMessages() {
    this.setData({ loading:true });
    try {
      const raw=await request<any>({ path:`/api/miniprogram/v1/inquiries/${encodeURIComponent(this.data.orderId)}/messages`,timeout:60000 });
      const previous=new Map(this.data.messages.map((message:any)=>[String(message.key),message]));
      this.setData({ messages:messageList(raw).map(message=>{
        const saved:any=previous.get(String(message.key));
        return { ...message,side:isSellerMessage(message,this.data.storeId) ? 'seller' : 'buyer',
          translationText:saved?.translationText || '',translationVisible:Boolean(saved?.translationVisible),translationLoading:false };
      }) });
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
  },
  async translateMessage(event:WechatMiniprogram.TouchEvent) {
    const index=Number(event.currentTarget.dataset.index);
    const message=this.data.messages[index];
    if (!message || !String(message.content || '').trim()) { wx.showToast({ title:'该消息没有可翻译的文字',icon:'none' }); return; }
    if (message.translationText) {
      this.setData({ [`messages[${index}].translationVisible`]:!message.translationVisible });
      return;
    }
    this.setData({ [`messages[${index}].translationLoading`]:true });
    try {
      const data=await request<any>({ path:'/api/miniprogram/v1/message-translations',method:'POST',data:{
        threadType:'inquiry',threadId:this.data.orderId,messageKey:String(message.key),text:message.content,source:'auto',target:'zh-CN'
      },timeout:30000 });
      this.setData({ [`messages[${index}].translationText`]:data.text || '',[`messages[${index}].translationVisible`]:true });
    } catch (error) { showError(error); }
    finally { this.setData({ [`messages[${index}].translationLoading`]:false }); }
  },
  onChinese(event:WechatMiniprogram.TextareaInput) { this.setData({ chineseText:event.detail.value }); },
  onEnglish(event:WechatMiniprogram.TextareaInput) { this.setData({ englishText:event.detail.value }); },
  async translate() {
    if (!this.data.chineseText.trim()) { wx.showToast({ title:'请先输入中文内容',icon:'none' }); return; }
    this.setData({ translating:true });
    try { const data=await request<any>({ path:'/api/miniprogram/v1/translate',method:'POST',data:{ text:this.data.chineseText,source:'zh-CN',target:'en' } }); this.setData({ englishText:data.text || '' }); }
    catch (error) { showError(error); }
    finally { this.setData({ translating:false }); }
  },
  async send() {
    const text=this.data.englishText.trim();
    if (!text) { wx.showToast({ title:'请先翻译并确认英文',icon:'none' }); return; }
    const confirmed=await new Promise<boolean>(resolve=>wx.showModal({
      title:'确认发送售前回复',
      content:'将把当前英文内容发送给买家。请再次确认内容无误。',
      confirmText:'确认发送',
      success:result=>resolve(result.confirm),
      fail:()=>resolve(false)
    }));
    if (!confirmed) return;
    this.setData({ sending:true });
    try {
      await request({ path:`/api/miniprogram/v1/inquiries/${encodeURIComponent(this.data.orderId)}/messages`,method:'POST',data:{ text } ,timeout:60000 });
      this.setData({ chineseText:'',englishText:'' });
      wx.showToast({ title:'回复已发送',icon:'success' });
      await this.loadMessages();
    } catch (error) { showError(error); }
    finally { this.setData({ sending:false }); }
  }
});
