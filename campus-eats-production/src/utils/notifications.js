const crypto = require('crypto');
const { pool } = require('../config/db');
const { sendEmail, brandedEmail } = require('./email');

const PUBLIC_BASE_URL = () => String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const INVITE_MINUTES = Number(process.env.ORDER_TIMEOUT_MINUTES || 5);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function statusLabel(status) {
  return ({
    pending: 'Pending — waiting for a Campus Eats runner',
    accepted: 'Accepted by a Campus Eats runner',
    processing: 'Order placed with Tubatsi',
    ready: 'Order ready for collection',
    delivering: 'Out for delivery',
    delivered: 'Delivered',
    cancelled: 'Cancelled'
  })[status] || status;
}

async function getOrderContext(orderId) {
  const r = await pool.query(`SELECT o.id,o.status,o.total_cents,o.room_number,o.cancel_reason,o.accepted_by_staff_id,
    b.name AS building_name,c.full_name AS customer_name,c.email AS customer_email,c.phone AS customer_phone,
    s.full_name AS accepted_by_name
    FROM orders o
    JOIN buildings b ON b.id=o.building_id
    JOIN customers c ON c.id=o.customer_id
    LEFT JOIN staff s ON s.id=o.accepted_by_staff_id
    WHERE o.id=$1`, [orderId]);
  return r.rows[0] || null;
}

async function notifyCustomerStatus(orderId) {
  const o = await getOrderContext(orderId);
  if (!o || !o.customer_email) return;
  const shortId = o.id.slice(0, 8).toUpperCase();
  const runner = o.accepted_by_name ? `<p><b>Runner:</b> ${o.accepted_by_name}</p>` : '';
  const reason = o.status === 'cancelled' && o.cancel_reason ? `<p><b>Reason:</b> ${o.cancel_reason}</p>` : '';
  const subject = `Campus Eats order #${shortId}: ${statusLabel(o.status)}`;
  const html = brandedEmail('Order update', `<p>Hi ${o.customer_name},</p><p>Your Campus Eats order <b>#${shortId}</b> is now:</p><p style="font-size:18px"><b>${statusLabel(o.status)}</b></p>${runner}${reason}<p><b>Delivery:</b> ${o.building_name}${o.room_number ? ` — ${o.room_number}` : ''}</p>`);
  await sendEmail({to:o.customer_email,subject,text:`Campus Eats order #${shortId}: ${statusLabel(o.status)}.`,html});
}

async function createAndNotifyStaffInvites(orderId) {
  const order = await getOrderContext(orderId);
  if (!order) return;
  const staff = await pool.query(`SELECT id,full_name,email FROM staff
    WHERE is_active=TRUE AND email_enabled=TRUE AND email IS NOT NULL
      AND email NOT LIKE '%@staff.campuseats.local' ORDER BY full_name`);
  const base = PUBLIC_BASE_URL();
  await Promise.allSettled(staff.rows.map(async member => {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    await pool.query(`INSERT INTO staff_order_invites(order_id,staff_id,token_hash,expires_at)
      VALUES($1,$2,$3,now()+($4 || ' minutes')::interval)
      ON CONFLICT(order_id,staff_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,used_at=NULL`,
      [orderId, member.id, tokenHash, INVITE_MINUTES]);
    const link = `${base}/staff-accept.html?token=${encodeURIComponent(token)}`;
    const shortId=order.id.slice(0,8).toUpperCase();
    const subject=`New Campus Eats order #${shortId} — accept within ${INVITE_MINUTES} minutes`;
    const html=brandedEmail('New order available',`<p>Hi ${member.full_name},</p><p>A new order is waiting for a Campus Eats runner.</p><p><b>Order:</b> #${shortId}<br><b>Deliver to:</b> ${order.building_name}<br><b>Total:</b> R${(order.total_cents/100).toFixed(2)}</p><p>The first runner to accept gets the order. This link expires in ${INVITE_MINUTES} minutes.</p>`,{label:'Accept this order',url:link});
    await sendEmail({to:member.email,subject,text:`New Campus Eats order #${shortId}. Accept: ${link}`,html});
  }));
}

async function notifyStaffAccepted(orderId, acceptedStaffId) {
  const o = await getOrderContext(orderId);
  if (!o) return;
  const staff = await pool.query(`SELECT id,full_name,email FROM staff
    WHERE is_active=TRUE AND email_enabled=TRUE AND id<>$1 AND email IS NOT NULL
      AND email NOT LIKE '%@staff.campuseats.local'`, [acceptedStaffId]);
  const shortId=o.id.slice(0,8).toUpperCase();
  await Promise.allSettled(staff.rows.map(member => {
    const subject=`Campus Eats order #${shortId} accepted by ${o.accepted_by_name || 'another runner'}`;
    const html=brandedEmail('Order already assigned',`<p>Hi ${member.full_name},</p><p>Order <b>#${shortId}</b> has been accepted by <b>${o.accepted_by_name || 'another runner'}</b>.</p><p><b>Delivery:</b> ${o.building_name}</p>`);
    return sendEmail({to:member.email,subject,text:`Order #${shortId} was accepted by ${o.accepted_by_name || 'another runner'}.`,html});
  }));
}

async function sendVerificationCode(customer, code) {
  if (!customer.email) return;
  const subject='Verify your Campus Eats email';
  const html=brandedEmail('Verify your account',`<p>Hi ${customer.full_name},</p><p>Your Campus Eats verification code is:</p><p style="font-size:30px;letter-spacing:6px;font-weight:700">${code}</p><p>This code expires shortly. If you did not create this account, you can ignore this email.</p>`);
  await sendEmail({to:customer.email,subject,text:`Your Campus Eats verification code is ${code}.`,html});
}

module.exports = { sha256, getOrderContext, notifyCustomerStatus, createAndNotifyStaffInvites, notifyStaffAccepted, sendVerificationCode };
