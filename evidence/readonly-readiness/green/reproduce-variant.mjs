/** Offline diagnostic only. Reads user-owned source and runs extracted original functions on synthetic data.
 * Usage: node --experimental-strip-types tools/reproduce-review-observations.mjs <extracted-qf-root>
 * No dependency installation, network access, wallets, or source changes. */
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root = process.argv[2];
if (!root) throw new Error('Pass the extracted archive root containing project-qf and spec.');
const evidence = resolve(dirname(new URL(import.meta.url).pathname), '../evidence');
await mkdir(evidence,{recursive:true});
const apiPath = join(root,'project-qf/packages/adapter-meteora-dbc/src/index.ts');
const verifierPath = join(root,'spec/tools/program-verify/lib.mjs');
const api = await readFile(apiPath,'utf8');
const vf = await readFile(verifierPath,'utf8');
const apiStart=api.indexOf('export const RPC_RESPONSE_LIMITS');
const apiEnd=api.indexOf('/** The only way QF code should construct',apiStart);
if (apiStart < 0 || apiEnd < 0) throw new Error('Source markers changed; review manually.');
const temp=await mkdtemp(join(tmpdir(),'qf-review-'));
const output={scope:'Original-function extraction; synthetic offline inputs; NOT full SDK/verifier tests and NOT on-chain results',sourceHashes:{adapter:createHash('sha256').update(api).digest('hex'),verifier:createHash('sha256').update(vf).digest('hex')},observations:[]};
try {
 await writeFile(join(temp,'original.ts'),api.slice(apiStart,apiEnd));
 const {createBoundedFetch}=await import(pathToFileURL(join(temp,'original.ts')));
 let produced=0,cancelled=false;
 const chunks=128, chunkBytes=256;
 const stream=new ReadableStream({pull(c){if(produced===chunks){c.close();return;}produced++;c.enqueue(new Uint8Array(chunkBytes).fill(32));},cancel(){cancelled=true;}},{highWaterMark:0});
 const fn=createBoundedFetch({maxBytes:1024,fetchImpl:async()=>new Response(stream)});
 let err;
 try{await fn('https://synthetic.invalid');}catch(e){err=e.message;}
 assert.match(err,/RPC_RESPONSE_TOO_LARGE/);
 /* variant: record instead of asserting the deficiency */
 output.observations.push({id:'BODY-LIMIT',capBytes:1024,syntheticBytesProduced:produced*chunkBytes,allChunksConsumed:produced===chunks,chunksConsumed:produced,cancelled,returnedError:err,interpretation:'Oversize is detected only after complete materialization; not a streaming memory cap.'});

 const layout=JSON.parse(await readFile(join(root,'spec/tools/program-verify/layouts/damm-v2-config-layout.json'),'utf8'));
 const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 const encode=(b)=>{let n=0n;for(const v of b)n=(n<<8n)|BigInt(v);let s='';while(n){s=A[Number(n%58n)]+s;n/=58n;}let z=0;for(const v of b){if(v!==0)break;z++;}return '1'.repeat(z)+s;};
 const decode=(s)=>{let n=0n;for(const c of s)n=n*58n+BigInt(A.indexOf(c));const b=[];while(n){b.unshift(Number(n&255n));n>>=8n;}let z=0;for(const c of s){if(c!=='1')break;z++;}return Uint8Array.from([...Array(z).fill(0),...b]);};
 const authority='FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
 const damm='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
 const start1=vf.indexOf('function decodeStruct('),end1=vf.indexOf('async function anchorIdl(',start1);
 const start2=vf.indexOf('async function inspectConfig('),end2=vf.indexOf('/**\n * Runs every check',start2);
 if([start1,end1,start2,end2].some(n=>n<0))throw new Error('Verifier source markers changed.');
 const code=(vf.slice(start1,end1)+vf.slice(start2,end2)).replaceAll('export function ','function ');
 const ctx=vm.createContext({Buffer,Uint8Array,DAMM_V2_CONFIG_LAYOUT:layout,DAMM_V2_CONFIG_DISCRIMINATOR:Uint8Array.from(layout.account.discriminator),addrDec:{decode:encode},REQUIRED_CONFIGS:new Set(['Customizable']),COMMITMENT:'finalized',DAMM_V2:damm,DBC_POOL_AUTHORITY:authority,sanitizeError:e=>String(e),CONFIG_ROUTES:{Customizable:{poolCreatorAuthority:authority,configType:1,evidence:{}}},DAMM_V2_CONFIG_TYPES:{0:'Static',1:'Dynamic'}});
 vm.runInContext(code+'\nthis.inspectConfigForProbe=inspectConfig;',ctx);
 for(const configType of [0,1,255]){
  const data=Buffer.alloc(328);data.set(layout.account.discriminator);data.set(decode(authority),40);data[202]=configType;
  const rpc={getAccountInfoWithContext:async()=>({contextSlot:123,value:{owner:damm,executable:false,data}})};
  const results=await ctx.inspectConfigForProbe(rpc,'Customizable','A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck');
  assert.equal(results[0].value.decoded.config_type,configType);
  /* variant: record the status */
  output.observations.push({id:'CONFIG-TYPE',syntheticConfigType:configType,fullAccountBytes:328,decodedConfigType:results[0].value.decoded.config_type,compatibilityStatus:results[1].status,interpretation:configType===1?'Expected positive control for type only; not a complete real config.':'Original compatibility predicate does not validate required dynamic type.'});
 }
 await writeFile(join(evidence,'targeted-observations-variant-repaired.json'),JSON.stringify(output,null,2)+'\n');
 console.log(JSON.stringify(output,null,2));
}finally{await rm(temp,{recursive:true,force:true});}
