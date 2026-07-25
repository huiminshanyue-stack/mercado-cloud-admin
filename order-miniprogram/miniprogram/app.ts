App<IAppOption>({
  globalData: {
    token: wx.getStorageSync('mini_token') || '',
    user: wx.getStorageSync('mini_user') || null
  },
  setSession(token: string, user: MiniUser | null) {
    this.globalData.token = token;
    this.globalData.user = user;
    wx.setStorageSync('mini_token', token);
    if (user) wx.setStorageSync('mini_user', user);
    else wx.removeStorageSync('mini_user');
  },
  clearSession() {
    this.globalData.token = '';
    this.globalData.user = null;
    wx.removeStorageSync('mini_token');
    wx.removeStorageSync('mini_user');
  }
});
