const ORDER_ROLES = new Set(['admin', 'agent', 'user']);
const ORDER_TEST_USERNAMES = new Set(['CNTORO']);

function canAccessOrderManagement(user = {}) {
  const role = String(user.role || '').trim().toLowerCase();
  const username = String(user.username || '').trim().toUpperCase();
  return ORDER_ROLES.has(role) || ORDER_TEST_USERNAMES.has(username);
}

function canManageWarehouses(user = {}) {
  return String(user.role || '').trim().toLowerCase() === 'admin';
}

function formatWarehouseAddressForUser(address = {}, externalUserId = '') {
  const userId = String(externalUserId || '').trim().toUpperCase();
  const suffix = /^SY\d{5}$/.test(userId) ? `（${userId}）` : '';
  const recipientName = String(address.recipientName || address.recipient_name || '山月').trim() || '山月';
  const addressText = String(address.address || '').trim();
  return {
    ...address,
    recipientName,
    recipientDisplay: `${recipientName}${suffix}`,
    address: addressText,
    addressDisplay: `${addressText}${suffix}`,
    userIdentity: userId
  };
}

module.exports = { canAccessOrderManagement, canManageWarehouses, formatWarehouseAddressForUser };
