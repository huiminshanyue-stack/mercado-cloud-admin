'use strict';

const MARKETPLACE_QUESTION_SEARCH_ENDPOINT = 'https://api.mercadolibre.com/marketplace/questions/search';
const LOCAL_QUESTION_SEARCH_ENDPOINT = 'https://api.mercadolibre.com/questions/search';
const MARKETPLACE_ANSWER_ENDPOINT = 'https://api.mercadolibre.com/marketplace/answers';
const LOCAL_ANSWER_ENDPOINT = 'https://api.mercadolibre.com/answers';

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

module.exports = {
  MARKETPLACE_QUESTION_SEARCH_ENDPOINT,
  LOCAL_QUESTION_SEARCH_ENDPOINT,
  MARKETPLACE_ANSWER_ENDPOINT,
  LOCAL_ANSWER_ENDPOINT,
  isGlobalSellingAuthorization,
  productQuestionSearchEndpoint,
  productQuestionAnswerEndpoint
};
