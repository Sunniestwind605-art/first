require('dotenv').config();
const path=require('path');
const express=require('express');
const cors=require('cors');
const rateLimit=require('express-rate-limit');
const authRoutes=require('./routes/auth');
const orderRoutes=require('./routes/orders');
const staffRoutes=require('./routes/staff');
const catalogRoutes=require('./routes/catalog');
const {applySchema,seedDemoData}=require('./bootstrap');
const {startOrderTimeoutCron}=require('./utils/cron');

if(!process.env.JWT_SECRET)process.env.JWT_SECRET='campus-eats-demo-change-this-secret';
const app=express();
app.set('trust proxy',1);
app.use(cors());
app.use(express.json({limit:'1mb'}));
app.use('/api/auth',rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:true,legacyHeaders:false}));
app.get('/health',(_req,res)=>res.json({ok:true,service:'Campus Eats'}));
app.use('/api/catalog',catalogRoutes);
app.use('/api/auth',authRoutes);
app.use('/api/orders',orderRoutes);
app.use('/api/staff',staffRoutes);
app.use(express.static(path.join(__dirname,'..','public')));
app.get('*',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'Not found'});res.sendFile(path.join(__dirname,'..','public','index.html'));});
app.use((err,req,res,_next)=>{console.error('Unhandled error',err);res.status(500).json({error:'Internal server error'});});

const PORT=process.env.PORT||4000;
async function start(){
  await applySchema();
  await seedDemoData();
  app.listen(PORT,()=>{console.log(`Campus Eats listening on ${PORT}`);startOrderTimeoutCron();});
}
start().catch(err=>{console.error('Startup failed',err);process.exit(1);});
