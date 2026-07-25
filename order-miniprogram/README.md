# 山月助手订单小程序

第一阶段为只读内测版，共用现有 Railway 订单服务和 PostgreSQL 数据库。

## 导入微信开发者工具

1. 选择“导入项目”。
2. 项目目录选择本目录 `order-miniprogram`。
3. 确认 AppID 为 `wx0f97428df87ee76e`。
4. 开发阶段在“本地设置”中开启“不校验合法域名、TLS版本及HTTPS证书”。
5. 打开后可使用管理员或 CNTORO ERP 账号进行内测登录。

## 环境

- 开发版/体验版：`https://mercado-cloud-admin-production.up.railway.app`
- 正式版：`https://www.shanyue.site`

正式发布前，在微信后台配置 request 合法域名，并在 Railway 环境变量中设置：

```text
WECHAT_MINIPROGRAM_APPID=wx0f97428df87ee76e
WECHAT_MINIPROGRAM_SECRET=请在Railway后台填写，禁止提交到代码
```

认证完成前不需要另购服务器。当前开发版与体验版继续复用 Railway；切换正式域名时，只需让 `www.shanyue.site` 的 HTTPS 接口反向代理到同一服务，并在微信后台更新合法域名。

## 当前功能

- 微信登录接口及 ERP 账号绑定
- 认证期间 ERP 内测登录
- 用户隔离的授权店铺列表
- 订单筛选、分页、下拉刷新
- 订单详情、商品图片、账单和物流信息

写操作当前由服务端强制关闭。
