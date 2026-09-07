self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch(_){data={body:event.data?.text?.()||''}}
  const title=data.title||'Campus Eats';
  const options={body:data.body||'',icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:data.tag||'campus-eats',renotify:true,requireInteraction:Boolean(data.requireInteraction),data:{url:data.url||'/',...(data.data||{})}};
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=event.notification.data?.url||'/';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const client of list){if('focus'in client){client.navigate(target);return client.focus();}}
    if(clients.openWindow)return clients.openWindow(target);
  }));
});
