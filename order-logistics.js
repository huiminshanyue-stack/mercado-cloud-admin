'use strict';

const zlib=require('node:zlib');

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

function collectTrackingNumberCandidates(value,result=[],seen=new Set()) {
  if (!value || typeof value!=='object' || seen.has(value)) return result;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectTrackingNumberCandidates(item,result,seen);
    return result;
  }
  for (const [key,child] of Object.entries(value)) {
    if (/^(tracking_number|trackingnumber|tracking_id|trackingid|tracking_code|trackingcode|external_tracking_number|externaltrackingnumber|carrier_tracking_number|carriertrackingnumber|logistic_tracking_number|logistictrackingnumber|mail_no|mailno|waybill_number|waybillnumber)$/i.test(key)) {
      const normalized=normalizeOfficialTrackingNumber(child);
      if (normalized) result.push(normalized);
    }
    if (child && typeof child==='object') collectTrackingNumberCandidates(child,result,seen);
  }
  return result;
}

function isMelDistribution(method) {
  return String(method || '').toLowerCase().replace(/[^a-z0-9]/g,'').includes('meldistribution');
}

function isMelPublicTrackingNumber(value) {
  return /^\d{8,20}$/.test(normalizeOfficialTrackingNumber(value));
}

function publicOfficialTrackingNumber(method,value) {
  const normalized=normalizeOfficialTrackingNumber(value);
  if (isMelDistribution(method) && !isMelPublicTrackingNumber(normalized)) return '';
  return normalized;
}

function chooseOfficialTrackingNumber(method,candidates) {
  const normalized=[...new Set((candidates || []).map(normalizeOfficialTrackingNumber).filter(Boolean))];
  if (!normalized.length) return '';
  if (isMelDistribution(method)) return normalized.find(isMelPublicTrackingNumber) || normalized[0];
  return normalized[0];
}

function extractMelTrackingNumberFromPdf(pdf,excludedValues=[]) {
  const source=Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf || []);
  if (!source.length) return '';
  const buffers=[source];
  const binary=source.toString('latin1');
  for (const match of binary.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { buffers.push(zlib.inflateSync(Buffer.from(match[1],'latin1'))); } catch (_) { /* non-Flate stream */ }
  }
  const numbers=[];
  for (const buffer of buffers) {
    const text=buffer.toString('latin1');
    numbers.push(...(text.match(/(?<!\d)\d{8,20}(?!\d)/g) || []));
    for (const hex of text.matchAll(/<([0-9a-f]{16,120})>/gi)) {
      const decoded=Buffer.from(hex[1],'hex').toString('latin1').replace(/\0/g,'');
      numbers.push(...(decoded.match(/(?<!\d)\d{8,20}(?!\d)/g) || []));
    }
  }
  const excluded=new Set(excludedValues.map(value=>normalizeOfficialTrackingNumber(value)).filter(Boolean));
  const candidates=[...new Set(numbers.map(normalizeOfficialTrackingNumber))].filter(value=>!excluded.has(value));
  candidates.sort((left,right)=>{
    const score=value=>(value.length===12 ? 100 : 0)+(value.startsWith('3') ? 30 : 0)-
      (value.length>=15 ? 20 : 0);
    return score(right)-score(left);
  });
  return candidates.find(isMelPublicTrackingNumber) || '';
}

function buildExternalTrackingUrl(method,trackingNumber) {
  const number=normalizeOfficialTrackingNumber(trackingNumber);
  if (!number) return '';
  const provider=trackingLookupProvider(method);
  if (provider==='cainiao') return `https://global.cainiao.com/newDetail.htm?mailNoList=${encodeURIComponent(number)}`;
  if (provider==='17track') return `https://www.17track.net/zh-cn?nums=${encodeURIComponent(number)}`;
  return '';
}

module.exports={ normalizeOfficialTrackingNumber,trackingLookupProvider,buildExternalTrackingUrl,
  collectTrackingNumberCandidates,isMelDistribution,isMelPublicTrackingNumber,publicOfficialTrackingNumber,
  chooseOfficialTrackingNumber,extractMelTrackingNumberFromPdf };
