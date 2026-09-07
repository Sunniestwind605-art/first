const webpush = require('web-push');
const { pool } = require('../config/db');

function configured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

function setup() {
  if (!configured()) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return true;
}

function publicKey() {
  return process.env.VAPID_PUBLIC_KEY || '';
}

async function logPush({recipientType, recipientId, title, status, errorMessage=null}) {
  try {
    await pool.query(`INSERT INTO push_notifications(recipient_type,recipient_id,title,status,error_message)
      VALUES($1,$2,$3,$4,$5)`, [recipientType, recipientId, title, status, errorMessage]);
  } catch (e) {
    console.error('[push] log failed', e.message);
  }
}

async function sendToSubscription(row, payload, recipientType, recipientId) {
  if (!setup()) {
    await logPush({recipientType,recipientId,title:payload.title,status:'not_configured'});
    return {sent:false,reason:'not_configured'};
  }
  const subscription = {endpoint:row.endpoint, keys:{p256dh:row.p256dh, auth:row.auth_key}};
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {TTL:60, urgency:'high'});
    await logPush({recipientType,recipientId,title:payload.title,status:'sent'});
    return {sent:true};
  } catch (e) {
    const code = Number(e.statusCode || e.status || 0);
    if (code === 404 || code === 410) {
      await pool.query('UPDATE push_subscriptions SET is_active=FALSE,updated_at=now() WHERE id=$1', [row.id]);
    }
    await logPush({recipientType,recipientId,title:payload.title,status:'failed',errorMessage:String(e.message||e).slice(0,500)});
    throw e;
  }
}

async function sendToOwner(ownerType, ownerId, payload) {
  const column = ownerType === 'staff' ? 'staff_id' : 'customer_id';
  const r = await pool.query(`SELECT id,endpoint,p256dh,auth_key FROM push_subscriptions
    WHERE ${column}=$1 AND is_active=TRUE`, [ownerId]);
  const results = await Promise.allSettled(r.rows.map(row => sendToSubscription(row,payload,ownerType,ownerId)));
  return {subscriptions:r.rowCount,results};
}

module.exports = { configured, publicKey, sendToOwner };
