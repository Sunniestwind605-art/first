const express=require('express');
const {pool,withTransaction}=require('../config/db');
const {verifyToken,requireCustomer}=require('../middleware/auth');
const {createAndNotifyStaffInvites,notifyCustomerStatus}=require('../utils/notifications');
const router=express.Router();
const SERVICE_FEE_PERCENT=Number(process.env.SERVICE_FEE_PERCENT||10);
const MAX_PHOTO_BYTES=750*1024;

function parseDeliveryPhoto(value){
  if(!value)return null;
  const raw=String(value);
  const match=raw.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if(!match){const e=new Error('Photo must be a JPEG, PNG or WebP image');e.statusCode=400;throw e;}
  const buffer=Buffer.from(match[2],'base64');
  if(!buffer.length||buffer.length>MAX_PHOTO_BYTES){const e=new Error('Photo is too large. Use an image under 750 KB after compression.');e.statusCode=413;throw e;}
  return {mime:match[1],data:match[2]};
}

router.post('/',verifyToken,requireCustomer,async(req,res)=>{
  const {buildingId,roomNumber,paymentMethod,items,deliveryPhotoData}=req.body;
  if(!buildingId||!Array.isArray(items)||!items.length)return res.status(400).json({error:'buildingId and items are required'});
  if(paymentMethod&&!['cash','bank_transfer'].includes(paymentMethod))return res.status(400).json({error:'Invalid payment method'});
  for(const i of items){if(!i.menuItemId||!Number.isInteger(i.quantity)||i.quantity<=0)return res.status(400).json({error:'Invalid item payload'});}
  try{
    const photo=parseDeliveryPhoto(deliveryPhotoData);
    const order=await withTransaction(async client=>{
      const br=await client.query("SELECT id,name FROM buildings WHERE id=$1 AND is_active=TRUE AND campus_zone='Braamfontein Main Campus'",[buildingId]);
      if(!br.rowCount){const e=new Error('Delivery is currently limited to Wits Braamfontein Main Campus');e.statusCode=400;throw e;}
      const ids=[...new Set(items.map(i=>i.menuItemId))];
      const mr=await client.query('SELECT id,name,price_cents,is_available FROM menu_items WHERE id=ANY($1::uuid[])',[ids]);
      const map=new Map(mr.rows.map(x=>[x.id,x])); let subtotal=0; const lines=[];
      for(const requested of items){
        const m=map.get(requested.menuItemId); if(!m||!m.is_available){const e=new Error('Menu item unavailable');e.statusCode=400;throw e;}
        const line=m.price_cents*requested.quantity; subtotal+=line;
        lines.push({menuItemId:m.id,itemName:m.name,unitPriceCents:m.price_cents,quantity:requested.quantity,lineTotalCents:line});
      }
      const fee=Math.round(subtotal*SERVICE_FEE_PERCENT/100), total=subtotal+fee;
      const or=await client.query(`INSERT INTO orders(customer_id,building_id,room_number,subtotal_cents,fee_cents,total_cents,payment_method,status,delivery_photo_data,delivery_photo_mime,delivery_photo_added_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,CASE WHEN $8 IS NULL THEN NULL ELSE now() END) RETURNING *`,[req.user.id,buildingId,roomNumber||null,subtotal,fee,total,paymentMethod||'cash',photo?.data||null,photo?.mime||null]);
      const o=or.rows[0];
      for(const l of lines){await client.query(`INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price_cents,quantity,line_total_cents) VALUES($1,$2,$3,$4,$5,$6)`,[o.id,l.menuItemId,l.itemName,l.unitPriceCents,l.quantity,l.lineTotalCents]);}
      await client.query(`INSERT INTO order_status_events(order_id,status) VALUES($1,'pending')`,[o.id]);
      return {...o,delivery_photo_data:undefined,building_name:br.rows[0].name,items:lines};
    });
    Promise.allSettled([createAndNotifyStaffInvites(order.id),notifyCustomerStatus(order.id)]).catch(console.error);
    res.status(201).json({order});
  }catch(e){console.error('create order',e);res.status(e.statusCode||500).json({error:e.statusCode?e.message:'Failed to create order'});}
});

router.get('/',verifyToken,requireCustomer,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT o.id,o.status,o.total_cents,o.created_at,o.updated_at,b.name building_name,s.full_name accepted_by_name,
      (o.delivery_photo_data IS NOT NULL) has_delivery_photo,rv.rating review_rating,rv.comment review_comment
      FROM orders o JOIN buildings b ON b.id=o.building_id LEFT JOIN staff s ON s.id=o.accepted_by_staff_id
      LEFT JOIN order_reviews rv ON rv.order_id=o.id
      WHERE o.customer_id=$1 ORDER BY o.created_at DESC LIMIT 50`,[req.user.id]);
    res.json({orders:r.rows});
  }catch(e){console.error(e);res.status(500).json({error:'Failed to fetch orders'});}
});

router.get('/:id/photo',verifyToken,requireCustomer,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT delivery_photo_data,delivery_photo_mime FROM orders WHERE id=$1 AND customer_id=$2`,[req.params.id,req.user.id]);
    if(!r.rowCount)return res.status(404).json({error:'Order not found'});
    const row=r.rows[0];
    if(!row.delivery_photo_data)return res.status(404).json({error:'No delivery photo for this order'});
    res.setHeader('Content-Type',row.delivery_photo_mime||'image/jpeg');
    res.setHeader('Cache-Control','private, max-age=300');
    res.send(Buffer.from(row.delivery_photo_data,'base64'));
  }catch(e){console.error('customer photo',e);res.status(500).json({error:'Could not load photo'});}
});

router.post('/:id/review',verifyToken,requireCustomer,async(req,res)=>{
  try{
    const rating=Number(req.body.rating);
    const comment=String(req.body.comment||'').trim();
    if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({error:'Choose a rating from 1 to 5 stars'});
    if(comment.length>800)return res.status(400).json({error:'Review comment must be 800 characters or fewer'});
    const or=await pool.query('SELECT id,status FROM orders WHERE id=$1 AND customer_id=$2',[req.params.id,req.user.id]);
    if(!or.rowCount)return res.status(404).json({error:'Order not found'});
    if(or.rows[0].status!=='delivered')return res.status(409).json({error:'You can review an order after it has been delivered'});
    const r=await pool.query(`INSERT INTO order_reviews(order_id,customer_id,rating,comment) VALUES($1,$2,$3,$4)
      ON CONFLICT(order_id) DO NOTHING RETURNING id,order_id,rating,comment,created_at`,[req.params.id,req.user.id,rating,comment||null]);
    if(!r.rowCount)return res.status(409).json({error:'You already reviewed this order'});
    res.status(201).json({review:r.rows[0]});
  }catch(e){console.error('create review',e);res.status(500).json({error:'Could not save review'});}
});

router.get('/:id',verifyToken,requireCustomer,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT o.id,o.customer_id,o.building_id,o.room_number,o.subtotal_cents,o.fee_cents,o.total_cents,o.payment_method,o.status,
      o.accepted_by_staff_id,o.accepted_at,o.delivered_at,o.cancelled_at,o.cancel_reason,o.created_at,o.updated_at,
      (o.delivery_photo_data IS NOT NULL) has_delivery_photo,b.name building_name,s.full_name accepted_by_name
      FROM orders o JOIN buildings b ON b.id=o.building_id LEFT JOIN staff s ON s.id=o.accepted_by_staff_id WHERE o.id=$1 AND o.customer_id=$2`,[req.params.id,req.user.id]);
    if(!r.rowCount)return res.status(404).json({error:'Order not found'});
    const ir=await pool.query(`SELECT item_name,unit_price_cents,quantity,line_total_cents FROM order_items WHERE order_id=$1`,[req.params.id]);
    const er=await pool.query(`SELECT status,created_at FROM order_status_events WHERE order_id=$1 ORDER BY created_at`,[req.params.id]);
    const rr=await pool.query(`SELECT rating,comment,created_at FROM order_reviews WHERE order_id=$1`,[req.params.id]);
    res.json({order:{...r.rows[0],items:ir.rows,events:er.rows,review:rr.rows[0]||null}});
  }catch(e){console.error(e);res.status(500).json({error:'Failed to fetch order'});}
});
module.exports=router;
