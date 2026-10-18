import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AttachmentStore,attachmentText} from './attachments.mjs';
import {ProjectStore} from './project-store.mjs';
import {CodexBridge,editSchema,decodeEditResult} from './codex-bridge.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const codex=new CodexBridge({cwd:root});
const attachments=new AttachmentStore();
let port=Number(process.env.SLIDE_STUDIO_PORT||4317);
const token=process.env.SLIDE_STUDIO_TOKEN||crypto.randomBytes(24).toString('hex');
const dataRoot=process.env.SLIDE_STUDIO_DATA_DIR||root;
const projectDir=path.join(dataRoot,'project'),projectFile=path.join(projectDir,'deck.json');
const projectStore=new ProjectStore(path.join(dataRoot,'saved-presentations'));
fs.mkdirSync(projectDir,{recursive:true});
const peers=new Set();let lastHash='';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.zip':'application/zip','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg'};
const allowedOrigin=process.env.SLIDE_STUDIO_ALLOWED_ORIGIN;
function originAllowed(req){const origin=req.headers.origin;return !origin||origin===`http://127.0.0.1:${port}`||origin===`http://localhost:${port}`||(allowedOrigin&&origin===allowedOrigin);}
function authorized(req,url){const candidate=req.headers.authorization?.replace(/^Bearer /,'')||url.searchParams.get('token')||'';const a=Buffer.from(candidate),b=Buffer.from(token);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function validDeck(deck){return deck&&deck.version===1&&typeof deck.name==='string'&&Array.isArray(deck.slides)&&deck.slides.length>0&&Array.isArray(deck.assets)&&deck.theme;}
function frame(value){const data=Buffer.from(JSON.stringify(value));let header;if(data.length<126){header=Buffer.from([0x81,data.length]);}else if(data.length<65536){header=Buffer.alloc(4);header[0]=0x81;header[1]=126;header.writeUInt16BE(data.length,2);}else{header=Buffer.alloc(10);header[0]=0x81;header[1]=127;header.writeBigUInt64BE(BigInt(data.length),2);}return Buffer.concat([header,data]);}
function broadcast(message,predicate=()=>true){const packet=frame(message);for(const peer of peers){if(predicate(peer)&&!peer.socket.destroyed)peer.socket.write(packet);}}
async function receiveBody(req,limit=300*1024*1024){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw Error('入力サイズが上限を超えています。');chunks.push(chunk);}return Buffer.concat(chunks).toString();}
const server=http.createServer(async(req,res)=>{
 let url;try{url=new URL(req.url,`http://127.0.0.1:${port}`);}catch{return json(res,400,{error:'Invalid URL'});}
 if(!originAllowed(req))return json(res,403,{error:'Origin denied'});
 if(url.pathname==='/api/info')return json(res,200,{bridge:true,port});
 if(url.pathname.startsWith('/api/')){
  if(!authorized(req,url))return json(res,401,{error:'接続トークンが必要です。'});
  if(url.pathname==='/api/library'||url.pathname.startsWith('/api/library/')||url.pathname==='/api/workspace'){
   try{
    if(url.pathname==='/api/workspace'){
     if(req.method==='GET')return json(res,200,{workspace:projectStore.draft()});
     if(req.method==='PUT'){projectStore.saveDraft(JSON.parse(await receiveBody(req)));return json(res,200,{saved:true});}
    }else if(url.pathname==='/api/library'){
     if(req.method==='GET')return json(res,200,projectStore.list());
     if(req.method==='POST')return json(res,201,projectStore.save(JSON.parse(await receiveBody(req))));
    }else if(req.method==='GET')return json(res,200,projectStore.read(url.pathname.slice('/api/library/'.length)));
    return json(res,405,{error:'Method not allowed'});
   }catch(e){return json(res,e.status||400,{error:e.message});}
  }
  if(url.pathname==='/api/attachments'&&req.method==='POST'){
   try{return json(res,200,await attachments.add(JSON.parse(await receiveBody(req,15*1024*1024))));}catch(e){return json(res,400,{error:e.message});}
  }
  if(url.pathname.startsWith('/api/attachments/')&&req.method==='DELETE'){attachments.remove(url.pathname.slice('/api/attachments/'.length));return json(res,200,{deleted:true});}
  if(url.pathname.startsWith('/api/codex/')){
   const controller=new AbortController();res.on?.('close',()=>{if(!res.writableEnded)controller.abort();});
   try{
    if(url.pathname==='/api/codex/status'&&req.method==='GET')return json(res,200,await codex.status());
    if(url.pathname==='/api/codex/models'&&req.method==='GET')return json(res,200,{models:await codex.models()});
    if(url.pathname==='/api/codex/login'&&req.method==='POST')return json(res,200,await codex.login());
    if(url.pathname==='/api/codex/chat'&&req.method==='POST'){
     const raw=await receiveBody(req);if(Buffer.byteLength(raw)>1024*1024)return json(res,413,{error:'AIへの入力は1MB以下にしてください。'});
     const body=JSON.parse(raw);
     if(!Array.isArray(body.messages)||!body.context||typeof body.instructions!=='string'||(body.model!=null&&typeof body.model!=='string')||body.messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string'))return json(res,400,{error:'会話データが不正です。'});
     res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
     const send=value=>{if(!res.destroyed)res.write(JSON.stringify(value)+'\n');};
     try{const files=attachments.resolve(body.attachmentIds||[]);const result=await codex.edit({...body,attachmentText:attachmentText(files),imagePaths:files.filter(f=>f.kind==='image').map(f=>f.file)},{signal:controller.signal,onProgress:p=>send({type:'progress',...p})});send({type:'result',...result});}catch(e){send({type:'error',error:e.message});}finally{res.end();}return;
    }
    return json(res,404,{error:'Codex API not found'});
   }catch(e){return json(res,503,{error:e.message});}
  }
  if(url.pathname==='/api/ai'&&req.method==='POST'){
   const controller=new AbortController();res.on?.('close',()=>{if(!res.writableEnded)controller.abort();});
   let key='';
   try{
    const raw=await receiveBody(req);if(Buffer.byteLength(raw)>1024*1024)return json(res,413,{error:'AIへの入力は1MB以下にしてください。素材本体を含めないでください。'});
    const body=JSON.parse(raw);key=process.env.OPENAI_API_KEY||body.apiKey||'';
    if(typeof key!=='string'||!key.trim())return json(res,400,{error:'API設定でOpenAI APIキーを入力してください。'});
    if(typeof body.model!=='string'||!body.model.trim()||!Array.isArray(body.messages)||!body.context||typeof body.instructions!=='string')return json(res,400,{error:'AIリクエストの形式が不正です。'});
    if(body.messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string'))return json(res,400,{error:'会話データが不正です。'});
    const messages=body.messages.slice(-24);
    const files=attachments.resolve(body.attachmentIds||[]);
    const input=[{role:'system',content:body.instructions+' Output schema takes precedence: return reply and operations, each with op, slideId, elementId, index, slideJson, elementJson and changesJson. Use null for unused fields. Encode slide, element and changes as JSON strings in the respective fields.'},{role:'user',content:'CURRENT PROJECT CONTEXT (asset bytes omitted):\n'+JSON.stringify(body.context)},...messages,...(files.length?[{role:'user',content:[{type:'input_text',text:attachmentText(files)||'Attached reference images.'},...files.filter(f=>f.kind==='image').map(f=>({type:'input_image',image_url:'data:'+f.mime+';base64,'+fs.readFileSync(f.file).toString('base64')}))]}]:[])];
    const upstream=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key.trim()},body:JSON.stringify({model:body.model.trim(),store:false,input,max_output_tokens:8000,text:{format:{type:'json_schema',name:'slide_studio_edit',strict:true,schema:editSchema}}}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])});
    const data=await upstream.json();
    if(!upstream.ok){const message=String(data.error?.message||'OpenAI API request failed').split(key.trim()).join('[redacted]').replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]');return json(res,upstream.status,{error:message});}
    if(data.status==='incomplete')return json(res,422,{error:'返答が上限に達しました。編集範囲を小さくして再度依頼してください。'});
    const content=(data.output||[]).flatMap(item=>item.content||[]);
    if(content.some(c=>c.type==='refusal'))return json(res,422,{error:'この依頼への回答をモデルが保留しました。内容を調整してください。'});
    const text=content.filter(c=>c.type==='output_text').map(c=>c.text).join('')||data.output_text;
    const result=decodeEditResult(JSON.parse(text||'{}'));if(typeof result.reply!=='string'||typeof result.operationsJson!=='string'||!Array.isArray(JSON.parse(result.operationsJson)))throw Error('AIの返答形式が不正です。');
    return json(res,200,{...result,usage:data.usage||null});
   }catch(e){const message=e.name==='AbortError'||e.name==='TimeoutError'?'リクエストが中止されたか、時間切れになりました。':String(e.message).split(key||'__EMPTY_KEY__').join('[redacted]').replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]');return json(res,502,{error:message});}
  }
  if(url.pathname==='/api/project'&&req.method==='GET'){if(!fs.existsSync(projectFile))return json(res,404,{error:'project/deck.jsonがありません。画面から「ファイルに保存」してください。'});try{return json(res,200,JSON.parse(fs.readFileSync(projectFile,'utf8')));}catch{return json(res,422,{error:'deck.jsonが不正なJSONです。'});}}
  if(url.pathname==='/api/project'&&req.method==='PUT'){try{const text=await receiveBody(req),deck=JSON.parse(text);if(!validDeck(deck))return json(res,422,{error:'Invalid deck format'});const data=JSON.stringify(deck,null,2);fs.writeFileSync(projectFile+'.tmp',data);lastHash=crypto.createHash('sha256').update(data).digest('hex');fs.renameSync(projectFile+'.tmp',projectFile);return json(res,200,{saved:true});}catch(e){return json(res,400,{error:e.message});}}
  return json(res,404,{error:'API not found'});
 }
 if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'Method not allowed'});
 let requested;try{requested=decodeURIComponent(url.pathname);}catch{return json(res,400,{error:'Invalid path'});}
 const base=requested.startsWith('/media/')?projectDir:path.join(root,'dist');
 const target=path.resolve(base,'.'+(requested==='/'?'/index.html':requested));
 if(!target.startsWith(base+path.sep))return json(res,403,{error:'Path denied'});
 try{const stat=fs.statSync(target);if(!stat.isFile())throw Error();const real=fs.realpathSync(target);if(!real.startsWith(base+path.sep))return json(res,403,{error:'Path denied'});const headers={'Content-Type':mime[path.extname(target)]||'application/octet-stream','Cache-Control':'no-cache','Accept-Ranges':'bytes'};
  const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),stat.size-1):stat.size-1;if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${stat.size}`});if(req.method==='HEAD')return res.end();return fs.createReadStream(target,{start,end}).pipe(res);}
  res.writeHead(200,{...headers,'Content-Length':stat.size});if(req.method==='HEAD')return res.end();fs.createReadStream(target).pipe(res);
 }catch{json(res,404,{error:'File not found'});}
});
server.on('upgrade',(req,socket,head)=>{
 const url=new URL(req.url,`http://127.0.0.1:${port}`);
 if(!originAllowed(req)||!authorized(req,url)||req.headers['sec-websocket-version']!=='13'||!req.headers['sec-websocket-key']){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
 const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
 const peer={socket,role:'receiver',buffer:Buffer.alloc(0)};peers.add(peer);
 const consume=chunk=>{peer.buffer=Buffer.concat([peer.buffer,chunk]);while(peer.buffer.length>=2){const b=peer.buffer,opcode=b[0]&15;let len=b[1]&127,offset=2;if(!(b[0]&128)||!(b[1]&128)){socket.destroy();return;}if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);offset=4;}else if(len===127){if(b.length<10)return;const large=b.readBigUInt64BE(2);if(large>2097152n){socket.destroy();return;}len=Number(large);offset=10;}if(len>2097152){socket.destroy();return;}if(b.length<offset+4+len)return;const mask=b.subarray(offset,offset+4),payload=Buffer.from(b.subarray(offset+4,offset+4+len));for(let i=0;i<len;i++)payload[i]^=mask[i%4];peer.buffer=b.subarray(offset+4+len);if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}if(opcode===9){socket.write(Buffer.concat([Buffer.from([0x8a,len]),payload]));continue;}if(opcode!==1)continue;try{const msg=JSON.parse(payload.toString());if(msg.type==='subscribe')peer.role=msg.role==='editor'?'editor':'receiver';else if(msg.type==='cue')broadcast(msg,p=>p!==peer);else if(msg.type==='navigate')broadcast(msg,p=>p.role==='editor');}catch{socket.write(frame({type:'error',message:'Invalid JSON'}));}}};
 socket.on('data',consume);socket.on('close',()=>peers.delete(peer));socket.on('error',()=>peers.delete(peer));if(head.length)consume(head);socket.write(frame({type:'connected'}));
});
function watchProject(){fs.watchFile(projectFile,{interval:500},()=>{try{const data=fs.readFileSync(projectFile,'utf8'),hash=crypto.createHash('sha256').update(data).digest('hex');if(hash===lastHash)return;const deck=JSON.parse(data);if(!validDeck(deck))throw Error('Invalid deck format');lastHash=hash;broadcast({type:'project',deck},p=>p.role==='editor');console.log('deck.json updated → editor');}catch(e){if(e.code!=='ENOENT')console.error('deck.json:',e.message);}});}
server.listen(port,'127.0.0.1',()=>{port=server.address?.()?.port||port;watchProject();if(process.env.SLIDE_STUDIO_DESKTOP)console.log('SLIDE_STUDIO_READY '+JSON.stringify({port}));console.log(`Slide Studio: http://127.0.0.1:${port}\nBridge token: ${token}\nAI project file: ${projectFile}\nWebSocket: ws://127.0.0.1:${port}/?token=YOUR_TOKEN`);});
server.on('error',e=>{console.error(e.message);fs.unwatchFile(projectFile);process.exitCode=1;});

server.on('close',()=>{codex.stop();attachments.close();});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{codex.stop();attachments.close();fs.unwatchFile(projectFile);server.close();process.exit(0);});
