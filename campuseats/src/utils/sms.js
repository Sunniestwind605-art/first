const STAFF_PHONE_NUMBERS = (process.env.STAFF_PHONE_NUMBERS || '').split(',').map(x=>x.trim()).filter(Boolean);
async function sendSms(to, message) {
  console.log(`[SMS MOCK] -> ${to}: ${message}`);
  return { to, message, mock: true };
}
async function notifyStaffOfNewOrder(order) {
  const message = `New order #${order.id.slice(0,8)} — ${order.buildingName} — R${(order.totalCents/100).toFixed(2)}.`;
  await Promise.allSettled(STAFF_PHONE_NUMBERS.map(n=>sendSms(n,message)));
}
module.exports = { sendSms, notifyStaffOfNewOrder };
