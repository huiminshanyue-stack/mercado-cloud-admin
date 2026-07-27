'use strict';

function snapshotDeclaredValue(snapshot) {
  return snapshot?.declaredAtOrder || snapshot?.orderRecorded ||
    snapshot?.items?.[0]?.orderDimensions || null;
}

function snapshotVerifiedValue(snapshot) {
  return snapshot?.verifiedPackage || snapshot?.package?.dimensions || null;
}

function snapshotListingValue(snapshot) {
  return snapshot?.platformReturned || snapshot?.currentListing ||
    snapshot?.items?.find(item=>item?.listingDimensions)?.listingDimensions ||
    snapshotBillableWeight(snapshot) || null;
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

function weightInGrams(value) {
  if (!value || typeof value!=='object') return null;
  const weight=numericValue(value.weight);
  if (weight===null) return null;
  const unit=String(value.weightUnit || value.unit || 'g').trim().toLowerCase();
  const factor=['kg','kgs','kilogram','kilograms'].includes(unit) ? 1000 :
    (['mg','milligram','milligrams'].includes(unit) ? 0.001 :
      (['lb','lbs','pound','pounds'].includes(unit) ? 453.59237 :
        (['oz','ounce','ounces'].includes(unit) ? 28.349523125 : 1)));
  return Number((weight*factor).toFixed(3));
}

function scaleRatio(left,right) {
  if (!(left>0) || !(right>0)) return Number.POSITIVE_INFINITY;
  return Math.max(left,right)/Math.min(left,right);
}

function normalizeBillableWeight(value,referenceValues=[]) {
  if (!value || typeof value!=='object') return value || null;
  const grams=weightInGrams(value);
  const references=referenceValues.map(weightInGrams).filter(weight=>weight>0);
  if (!(grams>=100000) || !references.length) return value;
  const scaledGrams=grams/1000;
  const originalRatio=Math.min(...references.map(weight=>scaleRatio(grams,weight)));
  const scaledRatio=Math.min(...references.map(weight=>scaleRatio(scaledGrams,weight)));
  if (originalRatio<100 || scaledRatio>4) return value;
  return {
    ...value,
    weight:Number(scaledGrams.toFixed(3)),
    weightUnit:'g',
    unitScaleCorrected:true,
    rawWeight:value.weight,
    rawWeightUnit:value.weightUnit || value.unit || 'g'
  };
}

function normalizeDimensionSnapshotWeights(snapshot) {
  if (!snapshot || typeof snapshot!=='object') return snapshot;
  const normalized={ ...snapshot };
  const sourceItems=Array.isArray(snapshot.items) ? snapshot.items : [];
  const references=[
    snapshot.verifiedPackage,
    snapshot.package?.dimensions,
    snapshot.declaredAtOrder,
    snapshot.orderRecorded,
    snapshot.currentListing,
    ...sourceItems.flatMap(item=>[item?.orderDimensions,item?.listingDimensions])
  ].filter(Boolean);
  const correctedTop=normalizeBillableWeight(snapshot.billableWeight,references);
  if (correctedTop) normalized.billableWeight=correctedTop;
  normalized.items=sourceItems.map(item=>{
    if (!item || typeof item!=='object' || !item.billableWeight) return item;
    return { ...item,billableWeight:normalizeBillableWeight(item.billableWeight,references) };
  });
  if (snapshot.platformReturned?.platformWeightOnly) {
    normalized.platformReturned=normalizeBillableWeight(snapshot.platformReturned,references);
  }
  return normalized;
}

function dimensionSnapshotsDiffer(original,latest) {
  const declared=snapshotDeclaredValue(original);
  const verified=snapshotVerifiedValue(latest);
  if (!declared || !verified) return false;
  return JSON.stringify(normalizedDimensions(declared))!==JSON.stringify(normalizedDimensions(verified));
}

module.exports={ snapshotDeclaredValue,snapshotVerifiedValue,snapshotListingValue,
  snapshotBillableWeight,normalizedDimensions,dimensionSnapshotsDiffer,
  normalizeBillableWeight,normalizeDimensionSnapshotWeights };
