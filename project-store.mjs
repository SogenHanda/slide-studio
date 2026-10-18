import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class StoreError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export function validProject(d){return !!(d&&d.version===1&&typeof d.name==='string'&&d.name.length<=1000&&Array.isArray(d.slides)&&d.slides.length>0&&d.slides.length<=500&&Array.isArray(d.assets)&&d.theme&&d.slides.every(s=>s&&typeof s.id==='string'&&typeof s.title==='string')&&new Set(d.slides.map(s=>s.id)).size===d.slides.length);}
export class ProjectStore {
 constructor(directory){this.directory=directory;fs.mkdirSync(directory,{recursive:true,mode:0o700});}
 file(id){if(!/^[a-f0-9-]{36}$/.test(id))throw new StoreError('保存IDが不正です。');return path.join(this.directory,id+'.json');}
 atomic(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch{}}}
 summary(r){return{id:r.id,name:r.name,kind:r.kind,createdAt:r.createdAt,updatedAt:r.updatedAt,revision:r.revision,slideCount:r.deck.slides.length,preview:r.preview||'',titles:r.deck.slides.map(s=>[s.title,...(s.elements||[]).filter(e=>e.type==='text').map(e=>e.text)].join(' ').slice(0,2000)).slice(0,500)};}
 list(){const items=[],warnings=[];for(const name of fs.readdirSync(this.directory)){if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;try{items.push(this.summary(this.read(name.slice(0,-5))));}catch{warnings.push(name);}}return{items:items.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),warnings};}
 read(id){const file=this.file(id);if(!fs.existsSync(file))throw new StoreError('保存したスライドが見つかりません。',404);try{const r=JSON.parse(fs.readFileSync(file,'utf8'));if(r.id!==id||!validProject(r.deck)||!Number.isInteger(r.revision))throw Error();return r;}catch{throw new StoreError('保存ファイルを読み込めません。元ファイルは保持しています。',422);}}
 save({id,expectedRevision,deck,kind='project',preview=''}){
  if(!validProject(deck)||!['project','slide'].includes(kind)||kind==='slide'&&deck.slides.length!==1)throw new StoreError('保存するスライドの形式を確認してください。',422);
  if(typeof preview!=='string'||preview.length>3*1024*1024||preview&&!preview.startsWith('data:image/svg+xml'))throw new StoreError('プレビュー画像が不正です。',422);
  const creating=!id;id=id||crypto.randomUUID();const file=this.file(id),lock=file+'.lock';
  try{fs.mkdirSync(lock);}catch{throw new StoreError('別の保存処理が進行中です。少し待って再度保存してください。',409);}
  try{const old=creating?null:this.read(id);if(old&&expectedRevision!==old.revision)throw new StoreError('別の画面で更新されています。「別名で保存」で変更を残してください。',409);const now=new Date().toISOString();const r={id,kind,name:deck.name,createdAt:old?.createdAt||now,updatedAt:now,revision:(old?.revision||0)+1,preview,deck};this.atomic(file,r);return this.summary(r);}finally{fs.rmdirSync(lock);}
 }
 draft(){const file=path.join(this.directory,'workspace.json');if(!fs.existsSync(file))return null;try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new StoreError('前回の作業状態を読み込めません。保存一覧から開いてください。',422);}}
 saveDraft(value){if(!validProject(value.deck))throw new StoreError('下書きの形式が不正です。',422);this.atomic(path.join(this.directory,'workspace.json'),{deck:value.deck,index:Number.isInteger(value.index)?Math.max(0,Math.min(value.deck.slides.length-1,value.index)):0,activeId:value.activeId||null,activeRevision:value.activeRevision||null,preferences:{aiProvider:value.preferences?.aiProvider==='api'?'api':'codex',codexModel:typeof value.preferences?.codexModel==='string'?value.preferences.codexModel.slice(0,200):'',aiModel:typeof value.preferences?.aiModel==='string'?value.preferences.aiModel.slice(0,200):''}});}
}
