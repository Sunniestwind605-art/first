const cron = require('node-cron');
const { pool } = require('../config/db');
const TIMEOUT_MINUTES = Number(process.env.ORDER_TIMEOUT_MINUTES || 5);
async function cancelStaleOrders() {
  try {
    const result = await pool.query(`UPDATE orders SET status='cancelled', cancelled_at=now(), cancel_reason='timeout'
      WHERE status='pending' AND created_at < now() - ($1 || ' minutes')::interval RETURNING id`, [TIMEOUT_MINUTES]);
    if (result.rowCount) console.log(`[cron] Auto-cancelled ${result.rowCount} stale order(s)`);
    return result.rows;
  } catch (err) { console.error('[cron] sweep failed', err); return []; }
}
function startOrderTimeoutCron() {
  cron.schedule('* * * * *', cancelStaleOrders);
  console.log(`[cron] Order timeout sweep scheduled (${TIMEOUT_MINUTES}m)`);
}
module.exports = { cancelStaleOrders, startOrderTimeoutCron };
