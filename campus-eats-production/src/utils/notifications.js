const crypto = require('crypto');
const { pool } = require('../config/db');
const { sendToOwner } = require('./push');

const PUBLIC_BASE_URL = () => String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const INVITE_MINUTES = Number(process.env.ORDER_TIMEOUT_MINUTES || 5);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function statusLabel(status) {
  return ({
    pending: 'Waiting for a Campus Eats runner',
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
    b.name AS building_name,c.id AS customer_id,c.full_name AS customer_name,c.email AS customer_email,c.phone AS customer_phone,
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
  if (!o) return;
  const shortId = o.id.slice(0, 8).toUpperCase();
  const body = o.status === 'accepted' && o.accepted_by_name
    ? `${o.accepted_by_name} accepted your order. Delivery: ${o.building_name}.`
    : `${statusLabel(o.status)}. Delivery: ${o.building_name}.`;
  return sendToOwner('customer', o.customer_id, {
    title: `Campus Eats #${shortId}`,
    body,
    url: `/order-tracking.html?id=${encodeURIComponent(o.id)}`,
    tag: `order-${o.id}`,
    data: {orderId:o.id,status:o.status}
  });
}

async function createAndNotifyStaffInvites(orderId) {
  const order = await getOrderContext(orderId);
  if (!order) return;
  const staff = await pool.query(`SELECT id,full_name FROM staff
    WHERE is_active=TRUE AND role='runner' ORDER BY full_name`);
  const base = PUBLIC_BASE_URL();
  const shortId = order.id.slice(0,8).toUpperCase();
  await Promise.allSettled(staff.rows.map(async member => {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    await pool.query(`INSERT INTO staff_order_invites(order_id,staff_id,token_hash,expires_at)
      VALUES($1,$2,$3,now()+($4 || ' minutes')::interval)
      ON CONFLICT(order_id,staff_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,used_at=NULL`,
      [orderId, member.id, tokenHash, INVITE_MINUTES]);
    const relative = `/staff-accept.html?token=${encodeURIComponent(token)}`;
    const url = base ? `${base}${relative}` : relative;
    await sendToOwner('staff', member.id, {
      title: `New Campus Eats order #${shortId}`,
      body: `${order.building_name} · R${(order.total_cents/100).toFixed(2)} · Tap to accept within ${INVITE_MINUTES} min.`,
      url,
      tag: `new-order-${order.id}`,
      requireInteraction: true,
      data: {orderId:order.id,staffId:member.id}
    });
  }));
}

async function notifyStaffAccepted(orderId, acceptedStaffId) {
  const o = await getOrderContext(orderId);
  if (!o) return;
  const staff = await pool.query(`SELECT id FROM staff WHERE is_active=TRUE AND role='runner' AND id<>$1`, [acceptedStaffId]);
  const shortId = o.id.slice(0,8).toUpperCase();
  await Promise.allSettled(staff.rows.map(member => sendToOwner('staff',member.id,{
    title:`Order #${shortId} already assigned`,
    body:`${o.accepted_by_name || 'Another runner'} accepted this order.`,
    url:'/staff-dashboard.html',
    tag:`new-order-${o.id}`,
    data:{orderId:o.id,status:'accepted'}
  })));
}

module.exports = { sha256, getOrderContext, notifyCustomerStatus, createAndNotifyStaffInvites, notifyStaffAccepted };
