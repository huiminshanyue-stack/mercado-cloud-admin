const DEVELOPMENT_API = 'https://mercado-cloud-admin-production.up.railway.app';
const PRODUCTION_API = 'https://www.shanyue.site';

export function apiBase(): string {
  try {
    const env = wx.getAccountInfoSync().miniProgram.envVersion;
    return env === 'release' ? PRODUCTION_API : DEVELOPMENT_API;
  } catch (_) {
    return DEVELOPMENT_API;
  }
}

export const environments = {
  development: DEVELOPMENT_API,
  production: PRODUCTION_API
};
