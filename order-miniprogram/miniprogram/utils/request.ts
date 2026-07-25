import { apiBase } from './env';

interface RequestOptions {
  path: string;
  method?: WechatMiniprogram.RequestOption['method'];
  data?: WechatMiniprogram.IAnyObject;
  authenticated?: boolean;
}

export function request<T>(options: RequestOptions): Promise<T> {
  const app = getApp<IAppOption>();
  return new Promise((resolve,reject) => {
    wx.request<ApiResponse<T>>({
      url: `${apiBase()}${options.path}`,
      method: options.method || 'GET',
      data: options.data || {},
      timeout: 30000,
      header: {
        'Content-Type': 'application/json',
        ...(options.authenticated === false || !app.globalData.token
          ? {}
          : { Authorization: `Bearer ${app.globalData.token}` })
      },
      success(response) {
        const payload = response.data;
        if (response.statusCode === 401) {
          app.clearSession();
          reject(new Error(payload?.message || '登录已失效'));
          return;
        }
        if (response.statusCode >= 400 || !payload || payload.code !== 0) {
          reject(new Error(payload?.message || `请求失败（${response.statusCode}）`));
          return;
        }
        resolve(payload.data);
      },
      fail(error) { reject(new Error(error.errMsg || '网络连接失败')); }
    });
  });
}

export function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : '操作失败，请稍后重试';
  wx.showToast({ title: message.slice(0,20),icon:'none',duration:2800 });
}
