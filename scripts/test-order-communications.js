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
  productQuestionDetailEndpoint,
  communicationMessageDateValue,
  communicationMessageTimestamp,
  MARKETPLACE_ORDER_MESSAGE_ENDPOINT,
  ORDER_MESSAGE_ENDPOINT,
  marketplaceOrderUnreadEndpoint,
  marketplaceOrderPackMessagesEndpoint,
  localOrderPackMessagesEndpoint,
  orderPackMessagesEndpoint,
  orderPackMessagesParams,
  orderPackSendBody,
  marketplaceOrderUnreadParams,
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
assert.equal(productQuestionDetailEndpoint({ site_id:'CBT' },'123'),'https://api.mercadolibre.com/marketplace/questions/123');
assert.equal(productQuestionDetailEndpoint({ site_id:'MLB' },'123'),'https://api.mercadolibre.com/questions/123');
assert.equal(communicationMessageDateValue({ message_date:{ received:'2026-07-28T01:02:03Z',created:'old' } }),'2026-07-28T01:02:03Z');
assert.equal(communicationMessageDateValue({ date_created:'2026-07-27T01:02:03Z' }),'2026-07-27T01:02:03Z');
assert.equal(communicationMessageTimestamp({ message_date:{ created:'2026-07-28T01:02:03Z' } }),Date.parse('2026-07-28T01:02:03Z'));

assert.equal(marketplaceOrderUnreadEndpoint(),`${MARKETPLACE_ORDER_MESSAGE_ENDPOINT}/unread`);
assert.equal(
  marketplaceOrderPackMessagesEndpoint('2000014204613187'),
  `${MARKETPLACE_ORDER_MESSAGE_ENDPOINT}/packs/2000014204613187`
);
assert.equal(
  localOrderPackMessagesEndpoint('2000014204613187','3361645256'),
  `${ORDER_MESSAGE_ENDPOINT}/packs/2000014204613187/sellers/3361645256`
);
assert.equal(orderPackMessagesEndpoint({ site_id:'CBT' },'123','456'),`${MARKETPLACE_ORDER_MESSAGE_ENDPOINT}/packs/123`);
assert.equal(orderPackMessagesEndpoint({ site_id:'MLB' },'123','456'),`${ORDER_MESSAGE_ENDPOINT}/packs/123/sellers/456`);
assert.deepEqual(orderPackMessagesParams({ site_id:'CBT' }),{ limit:50,offset:0 });
assert.deepEqual(orderPackMessagesParams({ site_id:'MLB' }),{
  limit:50,offset:0,tag:'post_sale',mark_as_read:false
});
assert.deepEqual(orderPackMessagesParams({ site_id:'MLB' },{ markAsRead:true,limit:20,offset:10 }),{
  limit:20,offset:10,tag:'post_sale',mark_as_read:true
});
assert.deepEqual(orderPackSendBody({ site_id:'CBT' },{ text:'Hello',textTranslated:'Hola' }),{
  text:'Hello',text_translated:'Hola',attachments:[]
});
assert.deepEqual(orderPackSendBody({ site_id:'MLB' },{ sellerId:'123',buyerId:'456',text:'Hello' }),{
  from:{ user_id:123 },to:{ user_id:456 },text:'Hello',attachments:[]
});
assert.deepEqual(marketplaceOrderUnreadParams('3361645256'),{
  user_id:'3361645256',role:'seller',tag:'post_sale'
});
assert.notEqual(marketplaceOrderUnreadEndpoint(),MARKETPLACE_QUESTION_SEARCH_ENDPOINT);
assert.notEqual(marketplaceOrderPackMessagesEndpoint('1'),marketplaceClaimEndpoint('1','messages'));

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
