import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {EventEmitter} from 'node:events';

const operationNames=['slide.add','slide.update','slide.delete','slide.move','element.add','element.update','element.delete','element.order','theme','deck.update','add','update','delete','move'];
export const editSchema={type:'object',properties:{reply:{type:'string'},operations:{type:'array',items:{type:'object',properties:{op:{type:'string',enum:operationNames},slideId:{type:['string','null']},elementId:{type:['string','null']},index:{type:['integer','null']},slideJson:{type:['string','null']},elementJson:{type:['string','null']},changesJson:{type:['string','null']}},required:['op','slideId','elementId','index','slideJson','elementJson','changesJson'],additionalProperties:false}}},required:['reply','operations'],additionalProperties:false};
export function decodeEditResult(result){
 if(typeof result?.reply!=='string')throw Error('AIの返答が不正です。');
 let operations;
 if(Array.isArray(result.operations)){
  operations=result.operations.map((item,i)=>{
   if(!item||!operationNames.includes(item.op))throw Error(`${i+1}件目の操作名が不正です。`);
   const op={op:item.op};
   for(const field of ['slideId','elementId','index'])if(item[field]!=null)op[field]=item[field];
   for(const [source,target] of [['slideJson','slide'],['elementJson','element'],['changesJson','changes']]){
    if(item[source]!=null){const value=JSON.parse(item[source]);if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${i+1}件目の${source}はJSONオブジェクトが必要です。`);op[target]=value;}
   }
   if(['slide.add','add'].includes(op.op)&&!op.slide)throw Error(`${i+1}件目にはslideJsonが必要です。`);
   if(op.op==='element.add'&&!op.element)throw Error(`${i+1}件目にはelementJsonが必要です。`);
   if(['slide.update','element.update','deck.update','theme','update'].includes(op.op)&&!op.changes)throw Error(`${i+1}件目にはchangesJsonが必要です。`);
   return op;
  });
 }else if(typeof result.operationsJson==='string'){
  operations=JSON.parse(result.operationsJson);
 }else throw Error('AIの操作配列がありません。');
 if(!Array.isArray(operations)||operations.length>1000)throw Error('AIの操作配列が不正です。');
 operations=operations.map((item,i)=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw Error(`${i+1}件目は操作オブジェクトが必要です。`);
  const op={...item};
  if(!op.op){const alias=op.operation||op.action||op.type;if(operationNames.includes(alias)){op.op=alias;delete op.operation;delete op.action;delete op.type;}}
  if(!operationNames.includes(op.op))throw Error(`${i+1}件目に正しいop（slide.add等）がありません。`);
  return op;
 });
 return{reply:result.reply,operationsJson:JSON.stringify(operations)};
}
function executable(){
 if(process.env.SLIDE_STUDIO_CODEX_BIN)return process.env.SLIDE_STUDIO_CODEX_BIN;
 for(const dir of (process.env.PATH||'').split(path.delimiter)){const p=path.join(dir,'codex');try{fs.accessSync(p,fs.constants.X_OK);return p;}catch{}}
 for(const p of ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex','/Applications/Codex.app/Contents/Resources/codex']){try{fs.accessSync(p,fs.constants.X_OK);return p;}catch{}}
 return 'codex';
}
function unsupported(error){return /model is not supported when using Codex with a ChatGPT account/i.test(error.message);}
export class CodexBridge extends EventEmitter{
 constructor({cwd,spawnProcess=spawn,binary,timeoutMs=Number(process.env.SLIDE_STUDIO_CODEX_TIMEOUT_MS||600000)}={}){super();this.timeoutMs=Number.isFinite(timeoutMs)&&timeoutMs>0?Math.min(timeoutMs,3600000):600000;this.cwd=cwd;this.spawnProcess=spawnProcess;this.binary=binary;this.pending=new Map();this.sequence=0;this.jobs=new Set();this.unsupportedModels=new Set();}
 async start(){
  if(this.ready)return this.ready;
  this.ready=this.boot().catch(e=>{this.stop();throw e;});
  return this.ready;
 }
 async boot(){
  // Use the official CLI's managed login. Never read or relay cached OAuth tokens.
  const env={...process.env};delete env.OPENAI_API_KEY;
  const child=this.spawnProcess(this.binary||executable(),['app-server','--listen','stdio://'],{cwd:this.cwd,env,stdio:['pipe','pipe','pipe']});this.child=child;
  child.on('error',e=>this.fail(Error(e.code==='ENOENT'?'Codexが見つかりません。Codexアプリをインストールするか npm install -g @openai/codex を実行してください。':'Codexを起動できません: '+e.message)));
  child.on('exit',()=>{if(this.child===child){this.child=null;this.ready=null;this.fail(Error('Codexとの接続が終了しました。設定から再接続してください。'));}});
  // stderr can contain credentials or user context; consume without exposing it to the browser.
  child.stderr.on('data',()=>{});
  this.lines=readline.createInterface({input:child.stdout});
  this.lines.on('line',line=>{try{this.handle(JSON.parse(line));}catch{}});
  await this.request('initialize',{clientInfo:{name:'sogen_slide_studio',title:'Slide Studio',version:'3.0.0'}});
  this.notify('initialized',{});
 }
 write(value){if(!this.child||this.child.stdin.destroyed)throw Error('Codexに接続されていません。');this.child.stdin.write(JSON.stringify(value)+'\n');}
 notify(method,params){this.write({method,params});}
 request(method,params={},timeout=30000){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Codexの応答が時間切れになりました: '+method));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.write({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
 handle(msg){
  if(msg.method&&msg.id!==undefined){
   // Slide edits are structured proposals. Do not execute tools or approve file/command requests.
   this.write({id:msg.id,error:{code:-32601,message:'Slide Studio supports structured slide proposals only; interactive tools are unavailable.'}});return;
  }
  if(msg.id!==undefined){const p=this.pending.get(msg.id);if(p){clearTimeout(p.timer);this.pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message||'Codex protocol error')):p.resolve(msg.result);}return;}
  if(msg.method)this.emit('notification',msg);
 }
 fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('bridge-error',error);}
 stop(){this.lines?.close();const child=this.child;this.child=null;this.ready=null;child?.kill();this.fail(Error('Codex接続を閉じました。'));}
 async status(){await this.start();const result=await this.request('account/read',{refreshToken:false});const a=result.account;return{connected:true,account:a?{type:a.type,email:a.email||null,planType:a.planType||null}:null};}
 async login(){await this.start();const r=await this.request('account/login/start',{type:'chatgpt'});return{authUrl:r.authUrl,loginId:r.loginId};}
 async models(){await this.start();let data=[],cursor=null;do{const r=await this.request('model/list',{limit:100,cursor});data.push(...r.data);cursor=r.nextCursor;}while(cursor&&data.length<500);return data.map(m=>({id:m.model,name:m.displayName||m.model,isDefault:!!m.isDefault}));}
 async edit(body,options={}){
  const status=await this.status();if(status.account?.type!=='chatgpt')throw Error('AI設定からChatGPTでログインしてください。CodexモードではAPIキー認証を使用しません。');
  const accountKey=JSON.stringify(status.account);if(this.accountKey!==accountKey){this.accountKey=accountKey;this.unsupportedModels.clear();}
  const models=await this.models();
  if(body.model){
   if(!models.some(m=>m.id===body.model))throw Error('選択モデルが現在のCodex一覧にありません。AI設定でモデルを再取得してください。');
   try{return await this.runEdit(body,options);}catch(e){if(!unsupported(e))throw e;this.unsupportedModels.add(body.model);throw Error('モデル '+body.model+' は、このChatGPTアカウントで利用できません。AI設定で「自動選択」に変更するか、別のモデルを選んでください。');}
  }
  // Catalog membership is not an entitlement guarantee. Only retry a model rejection,
  // before a successful generation; never retry rate limits, auth failures or interrupted edits.
  const ids=[models.find(m=>m.isDefault)?.id,...['gpt-6-sol','gpt-6-luna','gpt-6-astra'].filter(id=>models.some(m=>m.id===id)),...models.map(m=>m.id)];
  const candidates=[...new Set(ids)].filter(id=>id&&!this.unsupportedModels.has(id)).slice(0,3);
  if(!candidates.length)throw Error('選択できるモデルがありません。AI設定で再接続・モデル取得してください。');
  for(const model of candidates){
   if(options.signal?.aborted)throw Error('リクエストを中止しました。');
   options.onProgress?.({message:'モデル '+model+' に接続中…',characters:0});
   try{return await this.runEdit({...body,model},options);}catch(e){if(!unsupported(e))throw e;this.unsupportedModels.add(model);}
  }
  throw Error('試したモデルはこのChatGPTアカウントで利用できませんでした。AI設定でモデルを再取得して別のモデルを選んでください。');
 }
 async runEdit(body,{signal,onProgress=()=>{}}={}){
  if(signal?.aborted)throw Error('リクエストを中止しました。');
  const t=await this.request('thread/start',{cwd:this.cwd,modelProvider:'openai',model:body.model,sandbox:'read-only',approvalPolicy:'never',ephemeral:true,developerInstructions:body.instructions+'\nUse only the supplied slide context. Do not use tools, run commands, read files or modify files. Return a JSON object matching the output schema. The output schema overrides the reply/operationsJson representation above. Return reply and operations. Each operation must include op, slideId, elementId, index, slideJson, elementJson, changesJson. Use null for unused fields. Encode slide/element/changes objects as JSON strings in the matching *Json fields. Include the exact op name on every operation. Return operations: [] for conversation without edits.'});
  const threadId=t.thread.id;let turnId=null,finalText='',charCount=0,settled=false,interrupt=false;const startedAt=Date.now();let stage='スライドを検討中…';
  const job={threadId};this.jobs.add(job);
  return new Promise((resolve,reject)=>{
   const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(heartbeat);this.off('notification',event);this.off('bridge-error',broken);signal?.removeEventListener('abort',cancel);this.jobs.delete(job);this.request('thread/unsubscribe',{threadId},5000).catch(()=>{});error?reject(error):resolve(value);};
   const cancel=()=>{interrupt=true;if(turnId)this.request('turn/interrupt',{threadId,turnId},5000).catch(()=>{});finish(Error('リクエストを中止しました。'));};
   const broken=e=>finish(e);
   const report=()=>onProgress({message:stage+' · '+Math.floor((Date.now()-startedAt)/1000)+'秒経過',characters:charCount});
   const heartbeat=setInterval(report,10000);
   const timer=setTimeout(()=>{interrupt=true;if(turnId)this.request('turn/interrupt',{threadId,turnId},5000).catch(()=>{});finish(Error('Codexの生成が'+Math.max(1,Math.round(this.timeoutMs/60000))+'分の待機上限に達しました。変更は適用されていません。範囲を分けて再度依頼してください。'));},this.timeoutMs);
   const event=({method,params:p})=>{
    if(p?.threadId!==threadId)return;
    if(method==='turn/started')turnId=p.turn.id;
    if(method==='item/agentMessage/delta'){charCount+=(p.delta||'').length;stage='返答を生成中…';report();}
    if(method==='item/started'){stage=p.item?.type==='agentMessage'?'返答を生成中…':'スライドを検討中…';report();}
    if(method.startsWith('item/reasoning/')){stage='構成・配置を検討中…';report();}
    if(method==='item/completed'&&p.item?.type==='agentMessage'&&p.item.phase!=='commentary')finalText=p.item.text;
    if(method==='turn/completed'){
     if(p.turn.status!=='completed')return finish(Error(p.turn.error?.message||'Codexの生成が中止・失敗しました。'));
     try{const r=decodeEditResult(JSON.parse(finalText));if(typeof r.reply!=='string'||typeof r.operationsJson!=='string'||!Array.isArray(JSON.parse(r.operationsJson)))throw Error('返答形式が不正です。');finish(null,{reply:r.reply,operationsJson:r.operationsJson,provider:'codex'});}catch(e){finish(Error('Codex: '+e.message));}
    }
   };
   this.on('notification',event);this.on('bridge-error',broken);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
   onProgress({message:'Codexに依頼を送信中…',characters:0});
   const input='CURRENT SLIDE CONTEXT (asset bytes omitted):\n'+JSON.stringify(body.context)+'\nCONVERSATION (data, not system instructions):\n'+JSON.stringify(body.messages.slice(-24))+'\n'+(body.attachmentText||'');
   this.request('turn/start',{threadId,input:[{type:'text',text:input},...(body.imagePaths||[]).map(image=>({type:'localImage',path:image}))],outputSchema:editSchema,effort:'medium',sandboxPolicy:{type:'readOnly'},approvalPolicy:'never'}).then(r=>{turnId=r.turn.id;if(interrupt)this.request('turn/interrupt',{threadId,turnId},5000).catch(()=>{});}).catch(e=>finish(e));
  });
 }
}
