const express=require('express');
const {pool}=require('../config/db');
const {verifyToken}=require('../middleware/auth');
const {publicKey,configured}=require('../utils/push');
const router=express.Router();

router.get('/public-key',(_req,res)=>res.json({configured:configured(),publicKey:publicKey()}));

router.get('/staff-directory',verifyToken,async(req,res)=>{
  if(req.user?.type!=='staff')return res.status(403).json({error:'Staff account required'});
  const r=await pool.query(`SELECT id,full_name FROM staff WHERE is_active=TRUE AND role='runner' ORDER BY full_name`);
  res.json({staff:r.rows});
});

router.post('/subscribe',verifyToken,async(req,res)=>{
  try{
    const sub=req.body.subscription||{};
    if(!sub.endpoint||!sub.keys?.p256dh||!sub.keys?.auth)return res.status(400).json({error:'Invalid push subscription'});
    let customerId=null,staffId=null;
    if(req.user.type==='customer') customerId=req.user.id;
    else if(req.user.type==='staff') {
      staffId=String(req.body.staffId||'');
      if(!staffId)return res.status(400).json({error:'Choose which runner is using this device'});
      const s=await pool.query(`SELECT id FROM staff WHERE id=$1 AND is_active=TRUE AND role='runner'`,[staffId]);
      if(!s.rowCount)return res.status(400).json({error:'Invalid runner'});
    } else return res.status(403).json({error:'Account required'});
    await pool.query(`INSERT INTO push_subscriptions(customer_id,staff_id,endpoint,p256dh,auth_key,user_agent,is_active)
      VALUES($1,$2,$3,$4,$5,$6,TRUE)
      ON CONFLICT(endpoint) DO UPDATE SET customer_id=EXCLUDED.customer_id,staff_id=EXCLUDED.staff_id,p256dh=EXCLUDED.p256dh,auth_key=EXCLUDED.auth_key,user_agent=EXCLUDED.user_agent,is_active=TRUE,updated_at=now()`,
      [customerId,staffId,sub.endpoint,sub.keys.p256dh,sub.keys.auth,String(req.headers['user-agent']||'').slice(0,500)]);
    res.json({subscribed:true});
  }catch(e){console.error('push subscribe',e);res.status(500).json({error:'Could not enable notifications'});}
});

router.post('/unsubscribe',verifyToken,async(req,res)=>{
  try{
    const endpoint=String(req.body.endpoint||'');
    if(!endpoint)return res.status(400).json({error:'endpoint required'});
    await pool.query(`UPDATE push_subscriptions SET is_active=FALSE,updated_at=now() WHERE endpoint=$1`,[endpoint]);
    res.json({unsubscribed:true});
  }catch(e){res.status(500).json({error:'Could not disable notifications'});}
});

module.exports=router;
