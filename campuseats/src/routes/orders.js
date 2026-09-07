const express=require('express');
const {pool,withTransaction}=require('../config/db');
const {verifyToken,requireCustomer}=require('../middleware/auth');
const {notifyStaffOfNewOrder}=require('../utils/sms');
const router=express.Router();
const SERVICE_FEE_PERCENT=Number(process.env.SERVICE_FEE_PERCENT||10);

router.post('/',verifyToken,requireCustomer,async(req,res)=>{
  const {buildingId,roomNumber,paymentMethod,items}=req.body;
  if(!buildingId||!Array.isArray(items)||!items.length)return res.status(400).json({error:'buildingId and items are required'});
  if(paymentMethod&&!['cash','bank_transfer'].includes(paymentMethod))return res.status(400).json({error:'Invalid payment method'});
  for(const i of items){if(!i.menuItemId||!Number.isInteger(i.quantity)||i.quantity<=0)return res.status(400).json({error:'Invalid item payload'});}
  try{
    const order=await withTransaction(async client=>{
      const br=await client.query('SELECT id,name FROM buildings WHERE id=$1 AND is_active=TRUE',[buildingId]);
      if(!br.rowCount){const e=new Error('Building not found');e.statusCode=400;throw e;}
      const ids=[...new Set(items.map(i=>i.menuItemId))];
      const mr=await client.query('SELECT id,name,price_cents,is_available FROM menu_items WHERE id=ANY($1::uuid[])',[ids]);
      const map=new Map(mr.rows.map(x=>[x.id,x])); let subtotal=0; const lines=[];
      for(const requested of items){
        const m=map.get(requested.menuItemId); if(!m||!m.is_available){const e=new Error('Menu item unavailable');e.statusCode=400;throw e;}
        const line=m.price_cents*requested.quantity; subtotal+=line;
        lines.push({menuItemId:m.id,itemName:m.name,unitPriceCents:m.price_cents,quantity:requested.quantity,lineTotalCents:line});
      }
      const fee=Math.round(subtotal*SERVICE_FEE_PERCENT/100), total=subtotal+fee;
      const or=await client.query(`INSERT INTO orders(customer_id,building_id,room_number,subtotal_cents,fee_cents,total_cents,payment_method,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,[req.user.id,buildingId,roomNumber||null,subtotal,fee,total,paymentMethod||'cash']);
      const o=or.rows[0];
      for(const l of lines){await client.query(`INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price_cents,quantity,line_total_cents) VALUES($1,$2,$3,$4,$5,$6)`,[o.id,l.menuItemId,l.itemName,l.unitPriceCents,l.quantity,l.lineTotalCents]);}
      return {...o,building_name:br.rows[0].name,items:lines};
    });
    notifyStaffOfNewOrder({id:order.id,buildingName:order.building_name,totalCents:order.total_cents}).catch(console.error);
    res.status(201).json({order});
  }catch(e){console.error('create order',e);res.status(e.statusCode||500).json({error:e.statusCode?e.message:'Failed to create order'});}
});

router.get('/',verifyToken,requireCustomer,async(req,res)=>{
  try{const r=await pool.query(`SELECT o.id,o.status,o.total_cents,o.created_at,b.name building_name FROM orders o JOIN buildings b ON b.id=o.building_id WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50`,[req.user.id]);res.json({orders:r.rows});}
  catch(e){console.error(e);res.status(500).json({error:'Failed to fetch orders'});}
});
router.get('/:id',verifyToken,requireCustomer,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT o.*,b.name building_name FROM orders o JOIN buildings b ON b.id=o.building_id WHERE o.id=$1 AND o.customer_id=$2`,[req.params.id,req.user.id]);
    if(!r.rowCount)return res.status(404).json({error:'Order not found'});
    const ir=await pool.query(`SELECT item_name,unit_price_cents,quantity,line_total_cents FROM order_items WHERE order_id=$1`,[req.params.id]);
    res.json({order:{...r.rows[0],items:ir.rows}});
  }catch(e){console.error(e);res.status(500).json({error:'Failed to fetch order'});}
});
module.exports=router;
