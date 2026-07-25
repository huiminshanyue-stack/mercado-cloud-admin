'use strict';

function normalizeOfficialTrackingNumber(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff\ufffd]/g,'')
    .replace(/\s+/g,'')
    .trim();
}

function trackingLookupProvider(method) {
  const normalized=String(method || '').toLowerCase().replace(/[^a-z0-9]/g,'');
  if (normalized.includes('cainiao')) return 'cainiao';
  if (normalized.includes('meldistribution')) return '17track';
  return '';
}

function buildExternalTrackingUrl(method,trackingNumber) {
  const number=normalizeOfficialTrackingNumber(trackingNumber);
  if (!number) return '';
  const provider=trackingLookupProvider(method);
  if (provider==='cainiao') return `https://global.cainiao.com/newDetail.htm?mailNoList=${encodeURIComponent(number)}`;
  if (provider==='17track') return `https://www.17track.net/zh-cn?nums=${encodeURIComponent(number)}`;
  return '';
}

module.exports={ normalizeOfficialTrackingNumber,trackingLookupProvider,buildExternalTrackingUrl };
