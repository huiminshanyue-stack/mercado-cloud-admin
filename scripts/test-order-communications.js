'use strict';

const assert = require('node:assert/strict');
const {
  MARKETPLACE_QUESTION_SEARCH_ENDPOINT,
  LOCAL_QUESTION_SEARCH_ENDPOINT,
  MARKETPLACE_ANSWER_ENDPOINT,
  LOCAL_ANSWER_ENDPOINT,
  isGlobalSellingAuthorization,
  productQuestionSearchEndpoint,
  productQuestionAnswerEndpoint,
  marketplaceClaimEndpoint,
  claimAvailableActionNames,
  claimReplyReceiverRole,
  officialCommunicationError
} = require('../mercadolibre-communications');

assert.equal(isGlobalSellingAuthorization({ site_id:'CBT' }),true);
assert.equal(isGlobalSellingAuthorization({ site_id:'cbt' }),true);
assert.equal(isGlobalSellingAuthorization({ site_id:'MLB' }),false);
assert.equal(isGlobalSellingAuthorization(null),false);

assert.equal(productQuestionSearchEndpoint({ site_id:'CBT' }),MARKETPLACE_QUESTION_SEARCH_ENDPOINT);
assert.equal(productQuestionSearchEndpoint({ site_id:'MLB' }),LOCAL_QUESTION_SEARCH_ENDPOINT);
assert.equal(productQuestionAnswerEndpoint({ site_id:'CBT' }),MARKETPLACE_ANSWER_ENDPOINT);
assert.equal(productQuestionAnswerEndpoint({ site_id:'MLB' }),LOCAL_ANSWER_ENDPOINT);

assert.equal(
  marketplaceClaimEndpoint('5294629673','actions/send-message'),
  'https://api.mercadolibre.com/marketplace/v2/claims/5294629673/actions/send-message'
);
assert.equal(
  marketplaceClaimEndpoint('5294629673','messages'),
  'https://api.mercadolibre.com/marketplace/v2/claims/5294629673/messages'
);
const buyerReplyClaim = { players:[{ role:'respondent',available_actions:[{ action:'send_message_to_complainant' }] }] };
const mediatorReplyClaim = { players:[{ role:'respondent',available_actions:[{ action:'send_message_to_mediator' }] }] };
assert.deepEqual(claimAvailableActionNames(buyerReplyClaim),['send_message_to_complainant']);
assert.equal(claimReplyReceiverRole(buyerReplyClaim),'complainant');
assert.equal(claimReplyReceiverRole(mediatorReplyClaim),'mediator');
assert.equal(claimReplyReceiverRole({ players:[] }),'');
assert.match(officialCommunicationError({ response:{ status:400,data:{ message:'invalid action',cause:[{ message:'claim is closed' }] } } }).message,/invalid action/);
assert.match(officialCommunicationError({ response:{ status:401,data:{} } }).message,/重新授权/);

console.log('Mercado Libre presale communication endpoint regression tests passed');
