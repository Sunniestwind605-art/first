const crypto = require('crypto');
const { pool } = require('../config/db');
const { sendTemplate } = require('./whatsapp');

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
    b.name AS building_name,c.full_name AS customer_name,c.phone AS customer_phone,c.whatsapp_opt_in,
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
  if (!o || !o.whatsapp_opt_in) return;
  const shortId = o.id.slice(0, 8).toUpperCase();
  const accepted = o.accepted_by_name ? ` Runner: ${o.accepted_by_name}.` : '';
  const detail = o.status === 'cancelled' && o.cancel_reason ? ` Reason: ${o.cancel_reason}.` : accepted;
  await sendTemplate(o.customer_phone, process.env.WA_TEMPLATE_CUSTOMER_STATUS || 'campus_eats_order_status', [shortId, statusLabel(o.status), detail || '']);
}

async function createAndNotifyStaffInvites(orderId) {
  const order = await getOrderContext(orderId);
  if (!order) return;
  const staff = await pool.query(`SELECT id,full_name,phone FROM staff WHERE is_active=TRUE AND whatsapp_enabled=TRUE ORDER BY full_name`);
  const base = PUBLIC_BASE_URL();
  await Promise.allSettled(staff.rows.map(async member => {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    await pool.query(`INSERT INTO staff_order_invites(order_id,staff_id,token_hash,expires_at)
      VALUES($1,$2,$3,now()+($4 || ' minutes')::interval)
      ON CONFLICT(order_id,staff_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,used_at=NULL`,
      [orderId, member.id, tokenHash, INVITE_MINUTES]);
    const link = `${base}/staff-accept.html?token=${encodeURIComponent(token)}`;
    await sendTemplate(member.phone, process.env.WA_TEMPLATE_STAFF_NEW_ORDER || 'campus_eats_staff_new_order', [
      member.full_name,
      order.id.slice(0,8).toUpperCase(),
      order.building_name,
      `R${(order.total_cents/100).toFixed(2)}`,
      link
    ]);
  }));
}

async function notifyStaffAccepted(orderId, acceptedStaffId) {
  const o = await getOrderContext(orderId);
  if (!o) return;
  const staff = await pool.query(`SELECT id,full_name,phone FROM staff WHERE is_active=TRUE AND whatsapp_enabled=TRUE AND id<>$1`, [acceptedStaffId]);
  await Promise.allSettled(staff.rows.map(member => sendTemplate(member.phone,
    process.env.WA_TEMPLATE_STAFF_ACCEPTED || 'campus_eats_staff_order_accepted',
    [o.id.slice(0,8).toUpperCase(), o.accepted_by_name || 'Another runner', o.building_name]
  )));
}

async function sendVerificationCode(customer, code) {
  if (!customer.whatsapp_opt_in) return;
  await sendTemplate(customer.phone, process.env.WA_TEMPLATE_VERIFY || 'campus_eats_verify_account', [customer.full_name, code]);
}

module.exports = { sha256, getOrderContext, notifyCustomerStatus, createAndNotifyStaffInvites, notifyStaffAccepted, sendVerificationCode };
