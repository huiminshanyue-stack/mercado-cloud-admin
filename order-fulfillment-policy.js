function fulfillmentSubmissionEligibility(orderRows) {
  const rows = (Array.isArray(orderRows) ? orderRows : [orderRows]).filter(Boolean);
  if (!rows.length) return { allowed:false,message:'订单不存在' };
  if (rows.some(row => String(row.status || '').toLowerCase() === 'cancelled')) {
    return { allowed:false,message:'订单已取消，不允许提交代贴单' };
  }
  if (rows.some(row => String(row.status || '').toLowerCase() === 'refunded' || Number(row.refund_amount || 0) > 0 || Number(row.refund_amount_usd || 0) > 0)) {
    return { allowed:false,message:'订单已退款，不允许提交代贴单' };
  }
  const statuses = [...new Set(rows.map(row => String(row.shipment_status || '').toLowerCase()).filter(Boolean))];
  if (statuses.length === 1 && statuses[0] === 'ready_to_ship') return { allowed:true,message:'' };
  const labels = { ready_to_ship:'待发货',shipped:'运输中',delivered:'已送达',not_delivered:'未送达',handling:'处理中',pending:'待处理' };
  const statusText = statuses.map(status => labels[status] || status).join('、') || '未知状态';
  return { allowed:false,message:`订单当前状态为${statusText}，仅待发货订单可以提交代贴单` };
}

module.exports = { fulfillmentSubmissionEligibility };
