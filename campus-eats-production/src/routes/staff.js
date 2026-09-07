const express=require('express');
const {pool,withTransaction}=require('../config/db');
const {verifyToken,requireStaff}=require('../middleware/auth');
const {sha256,notifyCustomerStatus,notifyStaffAccepted}=require('../utils/notifications');
const router=express.Router();
const allowed=['pending','accepted','processing','ready','delivering','delivered','cancelled'];

async function attachItems(orders){
  if(!orders.length)return orders;
  const ids=orders.map(o=>o.id);
  const r=await pool.query(`SELECT order_id,item_name,quantity FROM order_items WHERE order_id=ANY($1::uuid[]) ORDER BY id`,[ids]);
  const map=new Map(); for(const row of r.rows){if(!map.has(row.order_id))map.set(row.order_id,[]);map.get(row.order_id).push({name:row.item_name,qty:row.quantity});}
  return orders.map(o=>({...o,items:map.get(o.id)||[]}));
}

router.get('/orders',verifyToken,requireStaff(),async(req,res)=>{
  try{
    const status=req.query.status; const params=[]; let where='';
    if(status&&status!=='all'){if(!allowed.includes(status))return res.status(400).json({error:'Invalid status'});params.push(status);where='WHERE o.status=$1';}
    const r=await pool.query(`SELECT o.id,o.status,o.total_cents,o.payment_method,o.room_number,o.created_at,o.accepted_at,o.cancel_reason,
      b.name building_name,c.full_name customer_name,c.phone customer_phone,s.full_name accepted_by_name
      FROM orders o JOIN buildings b ON b.id=o.building_id JOIN customers c ON c.id=o.customer_id
      LEFT JOIN staff s ON s.id=o.accepted_by_staff_id ${where}
      ORDER BY o.created_at DESC LIMIT 100`,params);
    res.json({orders:await attachItems(r.rows)});
  }catch(e){console.error('staff list',e);res.status(500).json({error:'Failed to fetch orders'});}
});

async function acceptOrder(orderId,staffId){
  return withTransaction(async client=>{
    const r=await client.query(`UPDATE orders SET status='accepted',accepted_by_staff_id=$1,accepted_at=now()
      WHERE id=$2 AND status='pending' RETURNING id,status,accepted_at`,[staffId,orderId]);
    if(!r.rowCount){
      const x=await client.query(`SELECT o.status,s.full_name accepted_by_name FROM orders o LEFT JOIN staff s ON s.id=o.accepted_by_staff_id WHERE o.id=$1`,[orderId]);
      if(!x.rowCount){const e=new Error('Order not found');e.statusCode=404;throw e;}
      const e=new Error(x.rows[0].accepted_by_name?`Order already accepted by ${x.rows[0].accepted_by_name}`:`Order is no longer pending (${x.rows[0].status})`);e.statusCode=409;throw e;
    }
    await client.query(`INSERT INTO order_status_events(order_id,status,changed_by_staff_id) VALUES($1,'accepted',$2)`,[orderId,staffId]);
    await client.query(`UPDATE staff_order_invites SET used_at=now() WHERE order_id=$1`,[orderId]);
    return r.rows[0];
  });
}

router.post('/orders/:id/accept',verifyToken,requireStaff(),async(req,res)=>{
  try{
    const order=await acceptOrder(req.params.id,req.user.id);
    Promise.allSettled([notifyCustomerStatus(order.id),notifyStaffAccepted(order.id,req.user.id)]).catch(console.error);
    res.json({order});
  }catch(e){res.status(e.statusCode||500).json({error:e.message||'Failed to accept order'});}
});

router.get('/invite/:token',async(req,res)=>{
  try{
    const hash=sha256(String(req.params.token||''));
    const r=await pool.query(`SELECT i.order_id,i.expires_at,i.used_at,st.full_name staff_name,o.status,o.total_cents,o.room_number,
      b.name building_name,c.full_name customer_name,s.full_name accepted_by_name
      FROM staff_order_invites i JOIN staff st ON st.id=i.staff_id JOIN orders o ON o.id=i.order_id
      JOIN buildings b ON b.id=o.building_id JOIN customers c ON c.id=o.customer_id
      LEFT JOIN staff s ON s.id=o.accepted_by_staff_id WHERE i.token_hash=$1`,[hash]);
    if(!r.rowCount)return res.status(404).json({error:'This acceptance link is invalid'});
    const row=r.rows[0];
    const ir=await pool.query(`SELECT item_name,quantity FROM order_items WHERE order_id=$1 ORDER BY id`,[row.order_id]);
    res.json({invite:{...row,expired:new Date(row.expires_at)<new Date(),items:ir.rows}});
  }catch(e){console.error('invite view',e);res.status(500).json({error:'Could not load order invitation'});}
});

router.post('/invite/:token/accept',async(req,res)=>{
  try{
    const hash=sha256(String(req.params.token||''));
    const invite=await pool.query(`SELECT id,order_id,staff_id,expires_at,used_at FROM staff_order_invites WHERE token_hash=$1`,[hash]);
    if(!invite.rowCount)return res.status(404).json({error:'This acceptance link is invalid'});
    const row=invite.rows[0];
    if(row.used_at)return res.status(409).json({error:'This acceptance link has already been used'});
    if(new Date(row.expires_at)<new Date())return res.status(410).json({error:'This acceptance link has expired'});
    const order=await acceptOrder(row.order_id,row.staff_id);
    Promise.allSettled([notifyCustomerStatus(order.id),notifyStaffAccepted(order.id,row.staff_id)]).catch(console.error);
    const who=await pool.query('SELECT full_name FROM staff WHERE id=$1',[row.staff_id]);
    res.json({order,acceptedBy:who.rows[0]?.full_name||'Campus Eats staff'});
  }catch(e){res.status(e.statusCode||500).json({error:e.message||'Failed to accept order'});}
});

const transitions={accepted:['processing','cancelled'],processing:['ready','cancelled'],ready:['delivering','cancelled'],delivering:['delivered','cancelled']};
router.post('/orders/:id/status',verifyToken,requireStaff(),async(req,res)=>{
  const next=req.body.status;
  if(!allowed.includes(next))return res.status(400).json({error:'Invalid status'});
  try{
    const cur=await pool.query('SELECT status,accepted_by_staff_id FROM orders WHERE id=$1',[req.params.id]);
    if(!cur.rowCount)return res.status(404).json({error:'Order not found'});
    const current=cur.rows[0];
    if(next==='cancelled'&&current.status==='pending'){
      const r=await pool.query(`UPDATE orders SET status='cancelled',cancelled_at=now(),cancel_reason='staff' WHERE id=$1 RETURNING id,status`,[req.params.id]);
      await pool.query(`INSERT INTO order_status_events(order_id,status,changed_by_staff_id) VALUES($1,'cancelled',$2)`,[req.params.id,req.user.id]);
      notifyCustomerStatus(req.params.id).catch(console.error);
      return res.json({order:r.rows[0]});
    }
    if(!(transitions[current.status]||[]).includes(next))return res.status(409).json({error:`Cannot move ${current.status} to ${next}`});
    if(current.accepted_by_staff_id!==req.user.id&&req.user.role!=='admin')return res.status(403).json({error:'This order is assigned to another staff member'});
    const extras=next==='delivered'?`, delivered_at=now()`:next==='cancelled'?`, cancelled_at=now(), cancel_reason='staff'`:'';
    const r=await pool.query(`UPDATE orders SET status=$1 ${extras} WHERE id=$2 RETURNING id,status,delivered_at,cancelled_at,cancel_reason`,[next,req.params.id]);
    await pool.query(`INSERT INTO order_status_events(order_id,status,changed_by_staff_id) VALUES($1,$2,$3)`,[req.params.id,next,req.user.id]);
    notifyCustomerStatus(req.params.id).catch(console.error);
    res.json({order:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:'Failed to update order'});}
});

router.post('/orders/:id/deliver',verifyToken,requireStaff(),async(req,res)=>{
  const cur=await pool.query('SELECT status,accepted_by_staff_id FROM orders WHERE id=$1',[req.params.id]);
  if(!cur.rowCount)return res.status(404).json({error:'Order not found'});
  if(cur.rows[0].status!=='delivering')return res.status(409).json({error:'Order must be out for delivery first'});
  if(cur.rows[0].accepted_by_staff_id!==req.user.id&&req.user.role!=='admin')return res.status(403).json({error:'This order is assigned to another staff member'});
  const r=await pool.query(`UPDATE orders SET status='delivered',delivered_at=now() WHERE id=$1 RETURNING id,status,delivered_at`,[req.params.id]);
  await pool.query(`INSERT INTO order_status_events(order_id,status,changed_by_staff_id) VALUES($1,'delivered',$2)`,[req.params.id,req.user.id]);
  notifyCustomerStatus(req.params.id).catch(console.error);
  res.json({order:r.rows[0]});
});
module.exports=router;
