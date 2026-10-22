'use strict';
const {spawn,execFileSync}=require('node:child_process'),http=require('node:http'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');const assert=require('node:assert/strict');const {LanService}=require('../src/core/service.cjs');
const root=path.resolve(__dirname,'..'),sdk=process.env.ANDROID_HOME||path.join(root,'android/.tooling/sdk'),adb=path.join(sdk,'platform-tools/adb'),serial=process.env.LINX_ANDROID_SERIAL||'emulator-5556';
const call=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8'});const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function hash(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
(async()=>{
 const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'linx-android-ui-'));const desktop=await new LanService({dataDir:path.join(temp,'desktop'),downloadDir:path.join(temp,'received'),discovery:false}).start();await desktop.setConfig({name:'电脑端联调终端'});
 const folder=path.join(temp,'电脑照片');await fsp.mkdir(path.join(folder,'空目录'),{recursive:true});const source=path.join(folder,'电脑发来的图片.png');await fsp.writeFile(source,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));await fsp.writeFile(path.join(folder,'大文件.bin'),Buffer.alloc(16*1024*1024,73));
 let phoneId,phonePort;const shots=path.join(root,'docs/screenshots');await fsp.mkdir(shots,{recursive:true});
 const controller=http.createServer(async(req,res)=>{try{let body='';for await(const b of req)body+=b;const data=JSON.parse(body||'{}');let result={ok:true};switch(req.url){
  case '/ready':phoneId=data.id;phonePort=data.port;call('forward','tcp:'+phonePort,'tcp:'+phonePort);console.log('✓ Android 15 服务启动与端口桥接');break;
  case '/outgoing-complete':{const t=[...desktop.transfers.values()].find(t=>t.status==='completed'&&t.direction==='incoming');assert.ok(t,'电脑应已接收图片');assert.equal(await hash(path.join(t.receiveDir,'微信分享原图.jpg')),data.imageHash);assert.equal((await fsp.stat(path.join(t.receiveDir,'空文件.txt'))).size,0);console.log('✓ Android 系统分享多文件导入，原图字节不变，真实界面发送到电脑');break;}
  case '/clipboard-complete':{const t=[...desktop.transfers.values()].find(t=>t.status==='completed'&&t.direction==='incoming'&&t.name==='电脑发来的图片.png');assert.ok(t);assert.equal(await hash(path.join(t.receiveDir,t.name)),data.imageHash);console.log('✓ Android 图片粘贴、输入法 commitContent 导入并发送到电脑，字节一致');break;}
  case '/send-to-phone':result={id:await desktop.sendFiles(phoneId,[folder])};break;
  case '/incoming-complete':assert.equal(data.imageHash,await hash(source));console.log('✓ 电脑文件夹→Android，界面接收确认、SHA-256、文件 Provider 只读');break;
  case '/background-message':await desktop.sendMessage(phoneId,'后台仍可接收消息');break;
  case '/capture-transfers':await delay(300);await fsp.writeFile(path.join(shots,'android-transfers.png'),execFileSync(adb,['-s',serial,'exec-out','screencap','-p'],{maxBuffer:16*1024*1024}));break;
  case '/capture-files':await delay(300);await fsp.writeFile(path.join(shots,'android-files.png'),execFileSync(adb,['-s',serial,'exec-out','screencap','-p'],{maxBuffer:16*1024*1024}));break;
  default:throw new Error('Unknown route');
 }res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
 await new Promise(r=>controller.listen(0,'127.0.0.1',r));const controlPort=controller.address().port;const handled=new Set();const autoAccept=setInterval(()=>{for(const t of desktop.transfers.values())if(t.direction==='incoming'&&t.status==='pending'&&!handled.has(t.id)){handled.add(t.id);desktop.accept(t.id,true).catch(console.error);}},100);
 try{
  console.log(call('install','-r',path.join(root,'android/app/build/outputs/apk/debug/app-debug.apk')).trim());console.log(call('install','-r',path.join(root,'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')).trim());call('shell','pm','clear','local.linx.android');call('shell','pm','grant','local.linx.android','android.permission.POST_NOTIFICATIONS');
  call('reverse','tcp:'+desktop.port,'tcp:'+desktop.port);call('reverse','tcp:'+controlPort,'tcp:'+controlPort);
  const child=spawn(adb,['-s',serial,'shell','am','instrument','-w','-r','-e','control_port',String(controlPort),'-e','desktop_port',String(desktop.port),'local.linx.android.test/local.linx.android.SmokeInstrumentation']);let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b);});child.stderr.pipe(process.stderr);const timer=setTimeout(()=>child.kill(),120000);await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Instrumentation exited '+code)));});clearTimeout(timer);assert.match(log,/INSTRUMENTATION_CODE: -1/);assert.match(log,/测试通过/);console.log('✓ Android 系统端到端测试通过，已保存手机界面截图');
 }finally{clearInterval(autoAccept);controller.close();await desktop.stop();if(phonePort)try{call('forward','--remove','tcp:'+phonePort);}catch{}for(const port of [desktop.port,controlPort])try{call('reverse','--remove','tcp:'+port);}catch{}await fsp.rm(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
