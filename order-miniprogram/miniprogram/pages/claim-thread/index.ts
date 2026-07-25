import { request,showError } from '../../utils/request';
import { isSellerMessage,messageList } from '../../utils/messages';

Page({
  data:{ claimId:'',storeId:'',orderNo:'',messages:[] as any[],loading:true,translating:false,sending:false,chineseText:'',englishText:'' },
  async onLoad(options:Record<string,string | undefined>) {
    this.setData({ claimId:String(options.claimId || ''),storeId:String(options.storeId || ''),orderNo:String(options.orderNo || '') });
    await this.loadMessages();
  },
  async loadMessages() {
    this.setData({ loading:true });
    try {
      const raw=await request<any>({ path:`/api/miniprogram/v1/after-sales/${encodeURIComponent(this.data.claimId)}/messages?storeId=${encodeURIComponent(this.data.storeId)}`,timeout:60000 });
      this.setData({ messages:messageList(raw).map(message=>({ ...message,side:isSellerMessage(message,this.data.storeId) ? 'seller' : 'buyer' })) });
    } catch (error) { showError(error); }
    finally { this.setData({ loading:false }); }
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
      title:'确认发送售后回复',
      content:'将把当前英文内容发送到售后申诉线程。请再次确认内容无误。',
      confirmText:'确认发送',
      success:result=>resolve(result.confirm),
      fail:()=>resolve(false)
    }));
    if (!confirmed) return;
    this.setData({ sending:true });
    try {
      await request({ path:`/api/miniprogram/v1/after-sales/${encodeURIComponent(this.data.claimId)}/messages`,method:'POST',data:{ text,storeId:this.data.storeId },timeout:60000 });
      this.setData({ chineseText:'',englishText:'' });
      wx.showToast({ title:'售后回复已发送',icon:'success' });
      await this.loadMessages();
    } catch (error) { showError(error); }
    finally { this.setData({ sending:false }); }
  }
});
