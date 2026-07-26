const COLOR_ATTRIBUTE_PATTERN = /(^|_)(COLOR|COLOUR|COR)(_|$)|颜色/i;

const COLOR_TRANSLATIONS = new Map([
  ['black', '黑色'], ['negro', '黑色'], ['preto', '黑色'],
  ['white', '白色'], ['blanco', '白色'], ['branco', '白色'],
  ['pink', '粉色'], ['rosa', '粉色'], ['rosado', '粉色'],
  ['red', '红色'], ['rojo', '红色'], ['vermelho', '红色'],
  ['blue', '蓝色'], ['azul', '蓝色'],
  ['green', '绿色'], ['verde', '绿色'],
  ['yellow', '黄色'], ['amarillo', '黄色'], ['amarelo', '黄色'],
  ['gray', '灰色'], ['grey', '灰色'], ['gris', '灰色'], ['cinza', '灰色'],
  ['brown', '棕色'], ['marron', '棕色'], ['marrom', '棕色'], ['cafe', '棕色'],
  ['purple', '紫色'], ['morado', '紫色'], ['violeta', '紫色'], ['roxo', '紫色'],
  ['orange', '橙色'], ['naranja', '橙色'], ['laranja', '橙色'],
  ['beige', '米色'], ['bege', '米色'],
  ['gold', '金色'], ['golden', '金色'], ['dorado', '金色'], ['dourado', '金色'],
  ['silver', '银色'], ['plateado', '银色'], ['prata', '银色'],
  ['transparent', '透明色'], ['transparente', '透明色'],
  ['multicolor', '多色'], ['multi color', '多色'], ['various', '多色'], ['varios', '多色'],
  ['navy', '藏青色'], ['navy blue', '藏青色'], ['azul marino', '藏青色'], ['azul marinho', '藏青色'],
  ['sky blue', '天蓝色'], ['celeste', '天蓝色'], ['turquoise', '青绿色'], ['turquesa', '青绿色']
]);

function normalizedWords(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function attributeValue(attribute) {
  if (!attribute || typeof attribute !== 'object') return '';
  const direct = attribute.value_name ?? attribute.valueName ?? attribute.value;
  if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct).trim();
  const first = Array.isArray(attribute.values) ? attribute.values[0] : null;
  return String(first?.name ?? first?.value_name ?? first?.value ?? '').trim();
}

function isColorAttribute(attribute) {
  const id = String(attribute?.id || attribute?.attribute_id || '').trim();
  const name = String(attribute?.name || attribute?.attribute_name || '').trim();
  return COLOR_ATTRIBUTE_PATTERN.test(id) || /(^|\s)(color|colour|cor)(\s|$)|颜色/i.test(name);
}

function findVariation(detail, variationId) {
  if (!detail || !variationId || !Array.isArray(detail.variations)) return null;
  return detail.variations.find(variation => String(variation?.id || '') === String(variationId)) || null;
}

function colorAttributes(entry, detail) {
  const item = entry?.item || {};
  const variation = findVariation(detail, item.variation_id ?? entry?.variation_id);
  return [
    item.variation_attributes,
    entry?.variation_attributes,
    entry?.variation?.attribute_combinations,
    entry?.variation?.attributes,
    variation?.attribute_combinations,
    variation?.attributes,
    item.attributes,
    detail?.attributes
  ].flatMap(value => Array.isArray(value) ? value : []);
}

function extractOrderItemColor(entry, detail) {
  const item = entry?.item || {};
  const existing = entry?.item?.colorOriginal || entry?.item?.color_original || entry?.colorOriginal || '';
  if (String(existing).trim()) return String(existing).trim();
  const attribute = colorAttributes(entry, detail).find(candidate => isColorAttribute(candidate) && attributeValue(candidate));
  const officialColor = attributeValue(attribute);
  if (officialColor) return officialColor;

  // Some historical order payloads no longer include variation attributes even
  // though the seller SKU still ends in an unambiguous color value.  Use this
  // only as a compatibility fallback for a known color translation; arbitrary
  // SKU fragments must never be presented to the user as a color.
  const sellerSku = String(item.seller_sku || item.sellerSku || entry?.seller_sku || '').trim();
  const skuParts = sellerSku.split(/[-_]/).map(part => part.trim()).filter(Boolean).reverse();
  return skuParts.find(part => COLOR_TRANSLATIONS.has(normalizedWords(part))) || '';
}

function translateColorPart(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/[\u3400-\u9fff]/.test(raw)) return raw;
  const normalized = normalizedWords(raw);
  if (COLOR_TRANSLATIONS.has(normalized)) return COLOR_TRANSLATIONS.get(normalized);

  const descriptor = /(^|\s)(light|claro|clara)(\s|$)/.test(normalized)
    ? '浅'
    : /(^|\s)(dark|oscuro|oscura|escuro|escura)(\s|$)/.test(normalized) ? '深' : '';
  for (const [source, translated] of COLOR_TRANSLATIONS) {
    if (source.includes(' ')) continue;
    if (new RegExp(`(^|\\s)${source}(\\s|$)`).test(normalized)) return `${descriptor}${translated}`;
  }
  return raw;
}

function translateColorName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.split(/\s*(?:\/|\+|&|,|;|\||\by\b|\be\b|\bcon\b|\bcom\b)\s*/i)
    .filter(Boolean)
    .map(translateColorPart)
    .join(' / ');
}

function normalizeOrderItem(entry, detail) {
  if (!entry || typeof entry !== 'object') return entry;
  const item = entry.item && typeof entry.item === 'object' ? entry.item : {};
  const colorOriginal = extractOrderItemColor(entry, detail);
  const colorNameZh = translateColorName(colorOriginal);
  return {
    ...entry,
    item: {
      ...item,
      colorOriginal,
      colorNameZh
    }
  };
}

function normalizeOrderItems(entries, detailsByItemId) {
  if (!Array.isArray(entries)) return [];
  return entries.map(entry => {
    const itemId = String(entry?.item?.id || '');
    const detail = detailsByItemId?.get ? detailsByItemId.get(itemId) : detailsByItemId?.[itemId];
    return normalizeOrderItem(entry, detail);
  });
}

module.exports = {
  extractOrderItemColor,
  translateColorName,
  normalizeOrderItem,
  normalizeOrderItems
};
