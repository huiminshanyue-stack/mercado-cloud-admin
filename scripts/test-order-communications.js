'use strict';

const assert = require('node:assert/strict');
const {
  MARKETPLACE_QUESTION_SEARCH_ENDPOINT,
  LOCAL_QUESTION_SEARCH_ENDPOINT,
  MARKETPLACE_ANSWER_ENDPOINT,
  LOCAL_ANSWER_ENDPOINT,
  isGlobalSellingAuthorization,
  productQuestionSearchEndpoint,
  productQuestionAnswerEndpoint
} = require('../mercadolibre-communications');

assert.equal(isGlobalSellingAuthorization({ site_id:'CBT' }),true);
assert.equal(isGlobalSellingAuthorization({ site_id:'cbt' }),true);
assert.equal(isGlobalSellingAuthorization({ site_id:'MLB' }),false);
assert.equal(isGlobalSellingAuthorization(null),false);

assert.equal(productQuestionSearchEndpoint({ site_id:'CBT' }),MARKETPLACE_QUESTION_SEARCH_ENDPOINT);
assert.equal(productQuestionSearchEndpoint({ site_id:'MLB' }),LOCAL_QUESTION_SEARCH_ENDPOINT);
assert.equal(productQuestionAnswerEndpoint({ site_id:'CBT' }),MARKETPLACE_ANSWER_ENDPOINT);
assert.equal(productQuestionAnswerEndpoint({ site_id:'MLB' }),LOCAL_ANSWER_ENDPOINT);

console.log('Mercado Libre presale communication endpoint regression tests passed');
