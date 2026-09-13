const express = require('express');
const { pool, withTransaction } = require('../config/db');
const { verifyToken, requireCustomer, requireStaff } = require('../middleware/auth');
const { sendToOwner } = require('../utils/push');

const router = express.Router();

function cleanText(value, max) {
  const text = String(value || '').trim();
  return text.slice(0, max);
}

async function notifyStaff(threadId, subject, customerName, body) {
  try {
    const r = await pool.query(`SELECT id FROM staff WHERE is_active=TRUE`);
    await Promise.allSettled(r.rows.map(s => sendToOwner('staff', s.id, {
      title: `Campus Eats support: ${subject}`,
      body: `${customerName}: ${body.slice(0, 140)}`,
      url: `/staff-support.html?thread=${encodeURIComponent(threadId)}`,
      tag: `support-${threadId}`,
      data: { type: 'support', threadId }
    })));
  } catch (e) {
    console.error('support staff notification', e.message);
  }
}

async function notifyCustomer(threadId, customerId, subject, body) {
  try {
    await sendToOwner('customer', customerId, {
      title: `Campus Eats support replied`,
      body: `${subject}: ${body.slice(0, 150)}`,
      url: `/help.html?thread=${encodeURIComponent(threadId)}`,
      tag: `support-${threadId}`,
      data: { type: 'support', threadId }
    });
  } catch (e) {
    console.error('support customer notification', e.message);
  }
}

router.get('/threads', verifyToken, requireCustomer, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT t.id,t.subject,t.status,t.created_at,t.updated_at,
        lm.message AS last_message,lm.sender_type AS last_sender,lm.created_at AS last_message_at
      FROM support_threads t
      LEFT JOIN LATERAL (
        SELECT message,sender_type,created_at FROM support_messages
        WHERE thread_id=t.id ORDER BY created_at DESC LIMIT 1
      ) lm ON TRUE
      WHERE t.customer_id=$1
      ORDER BY t.updated_at DESC
      LIMIT 50`, [req.user.id]);
    res.json({ threads: r.rows });
  } catch (e) {
    console.error('support customer list', e);
    res.status(500).json({ error: 'Could not load support conversations' });
  }
});

router.post('/threads', verifyToken, requireCustomer, async (req, res) => {
  try {
    const subject = cleanText(req.body.subject, 160);
    const message = cleanText(req.body.message, 2000);
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });
    const result = await withTransaction(async client => {
      const tr = await client.query(`INSERT INTO support_threads(customer_id,subject) VALUES($1,$2) RETURNING *`, [req.user.id, subject]);
      const thread = tr.rows[0];
      const mr = await client.query(`INSERT INTO support_messages(thread_id,sender_type,customer_id,message)
        VALUES($1,'customer',$2,$3) RETURNING id,thread_id,sender_type,message,created_at`, [thread.id, req.user.id, message]);
      return { thread, message: mr.rows[0] };
    });
    const cr = await pool.query('SELECT full_name FROM customers WHERE id=$1', [req.user.id]);
    notifyStaff(result.thread.id, result.thread.subject, cr.rows[0]?.full_name || 'Customer', message);
    res.status(201).json(result);
  } catch (e) {
    console.error('support create thread', e);
    res.status(500).json({ error: 'Could not create support conversation' });
  }
});

router.get('/threads/:id/messages', verifyToken, requireCustomer, async (req, res) => {
  try {
    const tr = await pool.query(`SELECT id,subject,status,created_at,updated_at FROM support_threads WHERE id=$1 AND customer_id=$2`, [req.params.id, req.user.id]);
    if (!tr.rowCount) return res.status(404).json({ error: 'Support conversation not found' });
    const mr = await pool.query(`
      SELECT m.id,m.sender_type,m.message,m.created_at,
        CASE WHEN m.sender_type='staff' THEN COALESCE(s.full_name,'Campus Eats staff') ELSE c.full_name END AS sender_name
      FROM support_messages m
      LEFT JOIN staff s ON s.id=m.staff_id
      LEFT JOIN customers c ON c.id=m.customer_id
      WHERE m.thread_id=$1 ORDER BY m.created_at`, [req.params.id]);
    res.json({ thread: tr.rows[0], messages: mr.rows });
  } catch (e) {
    console.error('support customer messages', e);
    res.status(500).json({ error: 'Could not load support messages' });
  }
});

router.post('/threads/:id/messages', verifyToken, requireCustomer, async (req, res) => {
  try {
    const message = cleanText(req.body.message, 2000);
    if (!message) return res.status(400).json({ error: 'Message is required' });
    const tr = await pool.query(`SELECT id,subject,status FROM support_threads WHERE id=$1 AND customer_id=$2`, [req.params.id, req.user.id]);
    if (!tr.rowCount) return res.status(404).json({ error: 'Support conversation not found' });
    if (tr.rows[0].status === 'closed') return res.status(409).json({ error: 'This conversation is closed. Start a new support conversation.' });
    const mr = await pool.query(`INSERT INTO support_messages(thread_id,sender_type,customer_id,message)
      VALUES($1,'customer',$2,$3) RETURNING id,thread_id,sender_type,message,created_at`, [req.params.id, req.user.id, message]);
    await pool.query('UPDATE support_threads SET updated_at=now() WHERE id=$1', [req.params.id]);
    const cr = await pool.query('SELECT full_name FROM customers WHERE id=$1', [req.user.id]);
    notifyStaff(req.params.id, tr.rows[0].subject, cr.rows[0]?.full_name || 'Customer', message);
    res.status(201).json({ message: mr.rows[0] });
  } catch (e) {
    console.error('support customer reply', e);
    res.status(500).json({ error: 'Could not send support message' });
  }
});

router.post('/threads/:id/close', verifyToken, requireCustomer, async (req, res) => {
  try {
    const r = await pool.query(`UPDATE support_threads SET status='closed',updated_at=now() WHERE id=$1 AND customer_id=$2 RETURNING id,status`, [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Support conversation not found' });
    res.json({ thread: r.rows[0] });
  } catch (e) {
    console.error('support customer close', e);
    res.status(500).json({ error: 'Could not close conversation' });
  }
});

router.get('/staff/threads', verifyToken, requireStaff(), async (req, res) => {
  try {
    const status = req.query.status === 'closed' ? 'closed' : req.query.status === 'all' ? null : 'open';
    const params = status ? [status] : [];
    const where = status ? 'WHERE t.status=$1' : '';
    const r = await pool.query(`
      SELECT t.id,t.subject,t.status,t.created_at,t.updated_at,c.full_name customer_name,c.email customer_email,
        lm.message AS last_message,lm.sender_type AS last_sender,lm.created_at AS last_message_at
      FROM support_threads t JOIN customers c ON c.id=t.customer_id
      LEFT JOIN LATERAL (
        SELECT message,sender_type,created_at FROM support_messages
        WHERE thread_id=t.id ORDER BY created_at DESC LIMIT 1
      ) lm ON TRUE
      ${where}
      ORDER BY t.updated_at DESC
      LIMIT 100`, params);
    res.json({ threads: r.rows });
  } catch (e) {
    console.error('support staff list', e);
    res.status(500).json({ error: 'Could not load support conversations' });
  }
});

router.get('/staff/threads/:id/messages', verifyToken, requireStaff(), async (req, res) => {
  try {
    const tr = await pool.query(`SELECT t.id,t.subject,t.status,t.created_at,t.updated_at,c.id customer_id,c.full_name customer_name,c.email customer_email
      FROM support_threads t JOIN customers c ON c.id=t.customer_id WHERE t.id=$1`, [req.params.id]);
    if (!tr.rowCount) return res.status(404).json({ error: 'Support conversation not found' });
    const mr = await pool.query(`
      SELECT m.id,m.sender_type,m.message,m.created_at,
        CASE WHEN m.sender_type='staff' THEN COALESCE(s.full_name,'Campus Eats staff') ELSE c.full_name END AS sender_name
      FROM support_messages m
      LEFT JOIN staff s ON s.id=m.staff_id
      LEFT JOIN customers c ON c.id=m.customer_id
      WHERE m.thread_id=$1 ORDER BY m.created_at`, [req.params.id]);
    res.json({ thread: tr.rows[0], messages: mr.rows });
  } catch (e) {
    console.error('support staff messages', e);
    res.status(500).json({ error: 'Could not load support messages' });
  }
});

router.post('/staff/threads/:id/messages', verifyToken, requireStaff(), async (req, res) => {
  try {
    const message = cleanText(req.body.message, 2000);
    if (!message) return res.status(400).json({ error: 'Message is required' });
    const tr = await pool.query('SELECT id,customer_id,subject,status FROM support_threads WHERE id=$1', [req.params.id]);
    if (!tr.rowCount) return res.status(404).json({ error: 'Support conversation not found' });
    if (tr.rows[0].status === 'closed') return res.status(409).json({ error: 'This conversation is closed' });
    const mr = await pool.query(`INSERT INTO support_messages(thread_id,sender_type,staff_id,message)
      VALUES($1,'staff',$2,$3) RETURNING id,thread_id,sender_type,message,created_at`, [req.params.id, req.user.id, message]);
    await pool.query('UPDATE support_threads SET updated_at=now() WHERE id=$1', [req.params.id]);
    notifyCustomer(req.params.id, tr.rows[0].customer_id, tr.rows[0].subject, message);
    res.status(201).json({ message: mr.rows[0] });
  } catch (e) {
    console.error('support staff reply', e);
    res.status(500).json({ error: 'Could not send support reply' });
  }
});

router.post('/staff/threads/:id/status', verifyToken, requireStaff(), async (req, res) => {
  try {
    const status = req.body.status === 'closed' ? 'closed' : req.body.status === 'open' ? 'open' : null;
    if (!status) return res.status(400).json({ error: 'Status must be open or closed' });
    const r = await pool.query('UPDATE support_threads SET status=$1,updated_at=now() WHERE id=$2 RETURNING id,status', [status, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Support conversation not found' });
    res.json({ thread: r.rows[0] });
  } catch (e) {
    console.error('support staff status', e);
    res.status(500).json({ error: 'Could not update conversation status' });
  }
});

module.exports = router;
