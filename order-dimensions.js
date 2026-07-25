'use strict';

function snapshotDeclaredValue(snapshot) {
  return snapshot?.declaredAtOrder || snapshot?.orderRecorded ||
    snapshot?.items?.[0]?.orderDimensions || null;
}

function snapshotVerifiedValue(snapshot) {
  return snapshot?.verifiedPackage || snapshot?.package?.dimensions || null;
}

function snapshotListingValue(snapshot) {
  return snapshot?.currentListing || snapshot?.items?.[0]?.listingDimensions || null;
}

function snapshotBillableWeight(snapshot) {
  return snapshot?.billableWeight || snapshot?.items?.find(item=>item?.billableWeight)?.billableWeight || null;
}

function numericValue(value) {
  const candidate=value && typeof value==='object' ? (value.value ?? value.number ?? value.amount) : value;
  const parsed=Number(String(candidate ?? '').replace(',','.').match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedDimensions(value) {
  if (!value || typeof value!=='object') return null;
  const dimensionUnit=String(value.dimensionUnit || 'cm').trim().toLowerCase();
  const weightUnit=String(value.weightUnit || 'g').trim().toLowerCase();
  const lengthFactor=dimensionUnit==='mm' ? 0.1 : (dimensionUnit==='m' ? 100 :
    (['in','inch','inches'].includes(dimensionUnit) ? 2.54 : 1));
  const weightFactor=['kg','kilogram','kilograms'].includes(weightUnit) ? 1000 :
    (['lb','lbs','pound','pounds'].includes(weightUnit) ? 453.59237 :
      (['oz','ounce','ounces'].includes(weightUnit) ? 28.349523125 : 1));
  const sides=[value.length,value.width,value.height]
    .map(raw=>numericValue(raw))
    .map(number=>number===null ? null : Number((number*lengthFactor).toFixed(3)))
    .sort((left,right)=>(left ?? Number.POSITIVE_INFINITY)-(right ?? Number.POSITIVE_INFINITY));
  const weight=numericValue(value.weight);
  return { sidesCm:sides,weightG:weight===null ? null : Number((weight*weightFactor).toFixed(3)) };
}

function dimensionSnapshotsDiffer(original,latest) {
  const declared=snapshotDeclaredValue(original);
  const verified=snapshotVerifiedValue(latest);
  if (!declared || !verified) return false;
  return JSON.stringify(normalizedDimensions(declared))!==JSON.stringify(normalizedDimensions(verified));
}

module.exports={ snapshotDeclaredValue,snapshotVerifiedValue,snapshotListingValue,
  snapshotBillableWeight,normalizedDimensions,dimensionSnapshotsDiffer };
