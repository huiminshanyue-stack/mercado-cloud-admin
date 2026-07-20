const API = 'https://mercado-cloud-admin-production.up.railway.app'
const $ = id => document.getElementById(id)
async function refresh() {
  const { collectorToken, collectorState } = await chrome.storage.local.get(['collectorToken','collectorState'])
  $('loginBox').hidden = !!collectorToken; $('controlBox').hidden = !collectorToken
  const s = collectorState || {}
  $('status').innerHTML = `<b>状态：</b>${s.status || (collectorToken?'已连接':'尚未连接')}<br><b>国家：</b>${s.country || '-'}　<b>已保存：</b>${s.saved || 0}<br><b>已处理页面：</b>${s.pages || 0}${s.message?'<br><span class="warn">'+s.message+'</span>':''}`
}
$('login').onclick = async () => {
  const res = await fetch(API + '/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('username').value.trim(),password:$('password').value})})
  const data = await res.json(); if(data.code!==0 || data.data?.user?.role!=='admin') return alert(data.message||'必须使用管理员账号')
  await chrome.storage.local.set({collectorToken:data.data.token}); $('password').value=''; refresh()
}
$('start').onclick = () => chrome.runtime.sendMessage({type:'START',country:$('country').value,delay:Math.max(2,Number($('delay').value)||5)},refresh)
$('stop').onclick = () => chrome.runtime.sendMessage({type:'STOP'},refresh)
$('logout').onclick = async () => { await chrome.storage.local.remove(['collectorToken','collectorState']); refresh() }
chrome.storage.onChanged.addListener(refresh); refresh()
