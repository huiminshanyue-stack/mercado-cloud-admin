'use strict';

const MARKETPLACE_QUESTION_SEARCH_ENDPOINT = 'https://api.mercadolibre.com/marketplace/questions/search';
const LOCAL_QUESTION_SEARCH_ENDPOINT = 'https://api.mercadolibre.com/questions/search';
const MARKETPLACE_ANSWER_ENDPOINT = 'https://api.mercadolibre.com/marketplace/answers';
const LOCAL_ANSWER_ENDPOINT = 'https://api.mercadolibre.com/answers';
const MARKETPLACE_CLAIM_ENDPOINT = 'https://api.mercadolibre.com/marketplace/v2/claims';

function isGlobalSellingAuthorization(authorization) {
  return String(authorization?.site_id || '').trim().toUpperCase() === 'CBT';
}

function productQuestionSearchEndpoint(authorization) {
  return isGlobalSellingAuthorization(authorization)
    ? MARKETPLACE_QUESTION_SEARCH_ENDPOINT
    : LOCAL_QUESTION_SEARCH_ENDPOINT;
}

function productQuestionAnswerEndpoint(authorization) {
  return isGlobalSellingAuthorization(authorization)
    ? MARKETPLACE_ANSWER_ENDPOINT
    : LOCAL_ANSWER_ENDPOINT;
}

function marketplaceClaimEndpoint(claimId, suffix = '') {
  const id = encodeURIComponent(String(claimId || '').trim());
  const normalizedSuffix = String(suffix || '').replace(/^\/+/, '');
  return `${MARKETPLACE_CLAIM_ENDPOINT}/${id}${normalizedSuffix ? `/${normalizedSuffix}` : ''}`;
}

function claimAvailableActionNames(claim) {
  const players = Array.isArray(claim?.players) ? claim.players : [];
  const respondent = players.find(player => String(player?.role || '').toLowerCase() === 'respondent');
  const actionGroups = [respondent?.available_actions, claim?.available_actions].filter(Array.isArray);
  return [...new Set(actionGroups.flat().map(item => String(item?.action || item || '').trim()).filter(Boolean))];
}

function claimReplyReceiverRole(claim) {
  const actions = claimAvailableActionNames(claim);
  if (actions.includes('send_message_to_complainant')) return 'complainant';
  if (actions.includes('send_message_to_mediator')) return 'mediator';
  return '';
}

function officialCommunicationError(error, fallback = '美客多通信接口调用失败') {
  const status = Number(error?.response?.status || error?.status || 502);
  let data = error?.response?.data;
  if (Buffer.isBuffer(data)) data = data.toString('utf8');
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = { message:data.trim() }; }
  }
  const causes = Array.isArray(data?.cause)
    ? data.cause.map(item => item?.message || item?.description || item?.code || item).filter(Boolean)
    : [];
  const reason = [data?.message, data?.error_description, data?.description, data?.error, ...causes]
    .map(item => String(item || '').trim()).filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index).join('；');
  if (status === 401) return { status, message:`店铺授权已失效，请重新授权后再回复${reason ? `（${reason}）` : ''}`, data };
  if (status === 403) return { status, message:`当前店铺身份无权回复该售后线程${reason ? `（${reason}）` : ''}`, data };
  if (status === 404) return { status, message:`该售后线程已不存在或已无法回复${reason ? `（${reason}）` : ''}`, data };
  if (status === 429) return { status, message:'美客多回复接口请求过于频繁，请稍后重试', data };
  return { status, message:reason ? `美客多官方拒绝发送：${reason}` : (error?.message || fallback), data };
}

module.exports = {
  MARKETPLACE_QUESTION_SEARCH_ENDPOINT,
  LOCAL_QUESTION_SEARCH_ENDPOINT,
  MARKETPLACE_ANSWER_ENDPOINT,
  LOCAL_ANSWER_ENDPOINT,
  isGlobalSellingAuthorization,
  productQuestionSearchEndpoint,
  productQuestionAnswerEndpoint,
  MARKETPLACE_CLAIM_ENDPOINT,
  marketplaceClaimEndpoint,
  claimAvailableActionNames,
  claimReplyReceiverRole,
  officialCommunicationError
};
