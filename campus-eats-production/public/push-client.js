(function(){
  function b64ToUint8Array(base64){const pad='='.repeat((4-base64.length%4)%4);const b=(base64+pad).replace(/-/g,'+').replace(/_/g,'/');const raw=atob(b);return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));}
  async function api(url,opt={}){const token=opt.token;delete opt.token;const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(opt.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Request failed');return d;}

  function supportInfo(){
    const ua=navigator.userAgent||'';
    const isIOS=/iPad|iPhone|iPod/i.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
    const standalone=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;
    const hasNotifications=typeof window!=='undefined'&&'Notification' in window;
    const hasServiceWorker='serviceWorker' in navigator;
    const hasPushManager=typeof window!=='undefined'&&'PushManager' in window;
    const supported=hasNotifications&&hasServiceWorker&&hasPushManager;
    let message='';
    if(!supported){
      if(isIOS&&!standalone){
        message='On iPhone or iPad, open Campus Eats directly in Safari, tap Share, choose Add to Home Screen, then open Campus Eats from the new Home Screen icon and enable notifications there. Web Push requires iOS/iPadOS 16.4 or later.';
      }else if(isIOS){
        message='This iPhone/iPad does not currently expose Web Push. Make sure iOS/iPadOS is 16.4 or later, then reopen Campus Eats from its Home Screen icon.';
      }else{
        message='This browser or in-app browser does not support Web Push. Open Campus Eats directly in a current browser such as Chrome, Edge, Firefox, or Safari and try again.';
      }
    }
    return {supported,isIOS,standalone,hasNotifications,hasServiceWorker,hasPushManager,message};
  }

  async function getRegistration(){
    const support=supportInfo();
    if(!support.supported)throw new Error(support.message);
    return navigator.serviceWorker.register('/sw.js');
  }

  async function subscribe(token,staffId){
    const support=supportInfo();
    if(!support.supported)throw new Error(support.message);
    const Notifications=window.Notification;
    if(Notifications.permission==='denied')throw new Error('Notifications are blocked for Campus Eats. Enable them in your browser or device notification settings first.');
    if(Notifications.permission!=='granted'){
      const permission=await Notifications.requestPermission();
      if(permission!=='granted')throw new Error('Notification permission was not granted. You can continue using live order tracking without push alerts.');
    }
    const key=await api('/api/push/public-key');
    if(!key.configured||!key.publicKey)throw new Error('Push notifications are not configured on the server yet.');
    const reg=await getRegistration();
    let sub=await reg.pushManager.getSubscription();
    if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToUint8Array(key.publicKey)});
    await api('/api/push/subscribe',{method:'POST',token,body:JSON.stringify({subscription:sub.toJSON(),staffId:staffId||undefined})});
    return true;
  }

  async function enableCustomer(){const token=localStorage.getItem('campusEatsToken');if(!token)throw new Error('Sign in first.');await subscribe(token);}
  async function enableStaff(staffId){const token=sessionStorage.getItem('campusEatsStaffToken');if(!token)throw new Error('Open the staff portal first.');await subscribe(token,staffId);localStorage.setItem('campusEatsRunnerId',staffId);}
  window.CampusEatsPush={enableCustomer,enableStaff,api,supportInfo};

  document.addEventListener('DOMContentLoaded',()=>{
    const customerToken=localStorage.getItem('campusEatsToken');
    const isStaff=location.pathname.includes('staff-');
    const support=supportInfo();
    const Notifications=support.hasNotifications?window.Notification:null;
    if(customerToken&&!isStaff&&Notifications&&Notifications.permission!=='granted'){
      const box=document.createElement('div');box.id='pushPrompt';box.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;background:#1F3823;color:white;border:2px solid #C9A227;border-radius:12px;padding:12px 14px;box-shadow:0 8px 24px #0004;font-family:Work Sans,Arial,sans-serif;display:flex;gap:10px;align-items:center;justify-content:space-between';
      box.innerHTML='<span style="font-size:13px;line-height:1.35"><b>Order notifications</b><br>Enable alerts for runner acceptance and delivery updates.</span><button style="border:0;border-radius:8px;background:#A8412C;color:white;padding:10px 12px;font-weight:700">Enable</button>';
      box.querySelector('button').onclick=async()=>{const btn=box.querySelector('button');btn.disabled=true;try{await enableCustomer();box.remove()}catch(e){alert(e.message);btn.disabled=false}};document.body.appendChild(box);
    }
  });
})();
