require('dotenv').config();
const path=require('path');
const express=require('express');
const cors=require('cors');
const rateLimit=require('express-rate-limit');
const authRoutes=require('./routes/auth');
const orderRoutes=require('./routes/orders');
const staffRoutes=require('./routes/staff');
const catalogRoutes=require('./routes/catalog');
const {applySchema,seedData}=require('./bootstrap');
const {startOrderTimeoutCron}=require('./utils/cron');
const {pool}=require('./config/db');
const {configured:whatsappConfigured}=require('./utils/whatsapp');

if(process.env.NODE_ENV==='production'&&!process.env.JWT_SECRET){
  throw new Error('JWT_SECRET is required in production');
}
if(!process.env.JWT_SECRET)process.env.JWT_SECRET='development-only-secret';

const app=express();
app.set('trust proxy',1);
app.disable('x-powered-by');

const allowedOrigins=(process.env.CORS_ORIGINS||process.env.PUBLIC_BASE_URL||'').split(',').map(x=>x.trim()).filter(Boolean);
app.use(cors({origin(origin,cb){if(!origin||!allowedOrigins.length||allowedOrigins.includes(origin))return cb(null,true);return cb(new Error('Origin not allowed'));},credentials:false}));
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(process.env.NODE_ENV==='production')res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({limit:'256kb'}));

const apiLimiter=rateLimit({windowMs:15*60*1000,limit:300,standardHeaders:true,legacyHeaders:false});
const authLimiter=rateLimit({windowMs:15*60*1000,limit:40,standardHeaders:true,legacyHeaders:false});
const inviteLimiter=rateLimit({windowMs:5*60*1000,limit:40,standardHeaders:true,legacyHeaders:false});
app.use('/api',apiLimiter);
app.use('/api/auth',authLimiter);
app.use('/api/staff/invite',inviteLimiter);

app.get('/health',async(_req,res)=>{
  try{
    await pool.query('SELECT 1');
    res.json({ok:true,service:'Campus Eats',database:'ok',whatsappConfigured:whatsappConfigured()});
  }catch(e){res.status(503).json({ok:false,service:'Campus Eats',database:'unavailable'});}
});
app.use('/api/catalog',catalogRoutes);
app.use('/api/auth',authRoutes);
app.use('/api/orders',orderRoutes);
app.use('/api/staff',staffRoutes);
app.use(express.static(path.join(__dirname,'..','public'),{dotfiles:'deny',index:'index.html',maxAge:process.env.NODE_ENV==='production'?'5m':0}));
app.get('*',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'Not found'});res.sendFile(path.join(__dirname,'..','public','index.html'));});
app.use((err,req,res,_next)=>{console.error('Unhandled error',err);res.status(500).json({error:'Internal server error'});});

const PORT=process.env.PORT||4000;
async function start(){
  await applySchema();
  await seedData();
  app.listen(PORT,()=>{console.log(`Campus Eats listening on ${PORT}`);startOrderTimeoutCron();});
}
start().catch(err=>{console.error('Startup failed',err);process.exit(1);});
