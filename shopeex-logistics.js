const catalog = require('./shopeex-logistics-catalog.json');

const aliases = Object.freeze({
  '邮政EMS': 'EMS',
  '菜鸟物流': '丹鸟（菜鸟速递）'
});

const byCode = new Map();
const byName = new Map();
for (const item of catalog) {
  const entry = Object.freeze({
    code: String(item.code || '').trim(),
    name: String(item.name || '').trim(),
    shipmentMethod: String(item.shipmentMethod || '').trim()
  });
  if (entry.code) byCode.set(entry.code,entry);
  if (entry.name) byName.set(entry.name,[...(byName.get(entry.name) || []),entry]);
}

function findShopeexLogisticsByCode(code) {
  return byCode.get(String(code || '').trim()) || null;
}

function findShopeexLogisticsByName(name) {
  const requested = String(name || '').trim();
  const resolvedName = aliases[requested] || requested;
  const matches = byName.get(resolvedName) || [];
  return matches.length === 1 ? matches[0] : null;
}

function resolveShopeexLogisticsCode(name,configuredCode = '') {
  const explicit = String(configuredCode || '').trim();
  if (explicit) return explicit;
  return findShopeexLogisticsByName(name)?.code || '';
}

function listShopeexLogisticsCatalog() {
  return catalog.map(item => ({
    code: String(item.code || '').trim(),
    name: String(item.name || '').trim(),
    shipmentMethod: String(item.shipmentMethod || '').trim()
  }));
}

module.exports = {
  SHOPEEX_LOGISTICS_CATALOG_SIZE: catalog.length,
  findShopeexLogisticsByCode,
  findShopeexLogisticsByName,
  resolveShopeexLogisticsCode,
  listShopeexLogisticsCatalog
};
