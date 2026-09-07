const express=require('express');
const {pool}=require('../config/db');
const {verifyToken,requireStaff}=require('../middleware/auth');
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
    const status=req.query.status;
    const params=[]; let where='';
    if(status&&status!=='all'){if(!allowed.includes(status))return res.status(400).json({error:'Invalid status'});params.push(status);where='WHERE o.status=$1';}
    const r=await pool.query(`SELECT o.id,o.status,o.total_cents,o.payment_method,o.room_number,o.created_at,o.accepted_at,o.cancel_reason,
      b.name building_name,c.full_name customer_name,c.phone customer_phone
      FROM orders o JOIN buildings b ON b.id=o.building_id JOIN customers c ON c.id=o.customer_id ${where}
      ORDER BY o.created_at DESC LIMIT 100`,params);
    res.json({orders:await attachItems(r.rows)});
  }catch(e){console.error('staff list',e);res.status(500).json({error:'Failed to fetch orders'});}
});

router.post('/orders/:id/accept',verifyToken,requireStaff(),async(req,res)=>{
  try{
    const r=await pool.query(`UPDATE orders SET status='accepted',accepted_by_staff_id=$1,accepted_at=now() WHERE id=$2 AND status='pending' RETURNING id,status,accepted_at`,[req.user.id,req.params.id]);
    if(r.rowCount)return res.json({order:r.rows[0]});
    const x=await pool.query('SELECT status FROM orders WHERE id=$1',[req.params.id]);
    if(!x.rowCount)return res.status(404).json({error:'Order not found'});
    return res.status(409).json({error:`Order is no longer pending (status: ${x.rows[0].status})`});
  }catch(e){console.error(e);res.status(500).json({error:'Failed to accept order'});}
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
      return res.json({order:r.rows[0]});
    }
    if(!(transitions[current.status]||[]).includes(next))return res.status(409).json({error:`Cannot move ${current.status} to ${next}`});
    if(current.accepted_by_staff_id!==req.user.id&&req.user.role!=='admin')return res.status(403).json({error:'This order is assigned to another staff member'});
    const extras=next==='delivered'?`, delivered_at=now()`:next==='cancelled'?`, cancelled_at=now(), cancel_reason='staff'`:'';
    const r=await pool.query(`UPDATE orders SET status=$1 ${extras} WHERE id=$2 RETURNING id,status,delivered_at,cancelled_at,cancel_reason`,[next,req.params.id]);
    res.json({order:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:'Failed to update order'});}
});

router.post('/orders/:id/deliver',verifyToken,requireStaff(),async(req,res)=>{
  const cur=await pool.query('SELECT status,accepted_by_staff_id FROM orders WHERE id=$1',[req.params.id]);
  if(!cur.rowCount)return res.status(404).json({error:'Order not found'});
  if(cur.rows[0].status!=='delivering')return res.status(409).json({error:'Order must be out for delivery first'});
  if(cur.rows[0].accepted_by_staff_id!==req.user.id&&req.user.role!=='admin')return res.status(403).json({error:'This order is assigned to another staff member'});
  const r=await pool.query(`UPDATE orders SET status='delivered',delivered_at=now() WHERE id=$1 RETURNING id,status,delivered_at`,[req.params.id]);
  res.json({order:r.rows[0]});
});
module.exports=router;
