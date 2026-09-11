const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const PORT=Number(process.env.PORT||8788),ROOT=__dirname,PUBLIC=path.join(ROOT,"public"),DATA=path.join(ROOT,"data");
if(!Number.isInteger(PORT)||PORT<1||PORT>65535)throw new Error("Invalid PORT: "+String(process.env.PORT));
const STATE_FILE=path.join(DATA,"state.json");
const RELEASE_VERIFY_FILE=path.join(DATA,"release-verification.json");
const POSTGRES_ADAPTER=path.join(ROOT,"db","postgres.js");
const SQLITE_ADAPTER=path.join(ROOT,"db","sqlite.js");
const PERSISTENCE_BACKEND=String(process.env.RAVEL_PERSISTENCE_BACKEND||"postgresql").toLowerCase();
const SQLITE_FILE=String(process.env.RAVEL_SQLITE_FILE||path.join(DATA,"ravel360.sqlite"));
let productionStore=null, persistenceDirty=false, persistenceRevision=0, persistenceVersion=null, persistenceFlush=Promise.resolve(), persistenceFailure=null;
const MAX_BODY_BYTES=1024*1024, MAX_FETCH_RESPONSE_BYTES=5*1024*1024, MAX_STATE_BYTES=16*1024*1024;
const SESSION_TTL_MS=8*60*60*1000, sessions=new Map(), COOKIE_SECURE=process.env.COOKIE_SECURE==="true"||process.env.NODE_ENV==="production";
const PRODUCTION=process.env.NODE_ENV==="production";
const PUBLIC_ORIGIN=String(process.env.RAVEL_PUBLIC_ORIGIN||"").replace(/\/$/,"");
const DEFAULT_TENANT_ID=String(process.env.RAVEL_API_TENANT_ID||"system");
const DEFAULT_ENVIRONMENT=String(process.env.RAVEL_DATA_ENVIRONMENT||"production").toLowerCase();
const DATA_PARTITION_FIELD="_ravelPartition";
function classifyRecord(v){
  if(!v||typeof v!=="object")return {tenantId:DEFAULT_TENANT_ID,environment:DEFAULT_ENVIRONMENT};
  const s=JSON.stringify(v).toLowerCase();
  const qa=/(^|[\"\s:_-])qa($|[\"\s:_-])|test|teste|synthetic|fixture/.test(s);
  return {tenantId:String(v.tenantId||v.tenant_id||(qa?"qa":"system")),environment:String(v.environment||v.env||(qa?"qa":"production")).toLowerCase()};
}
function isOperationalRecord(v){const p=v&&v[DATA_PARTITION_FIELD]||classifyRecord(v);return p.environment==="production"&&p.tenantId!=="qa";}
function partitionCollections(){
 const names=["leads","tasks","clients","crmLeads","evidence","contracts","proposals","engagements","factoryDocs","caseContexts","deliverables","juntaQueue","liveAlerts","agentMemory","agentOutcomes","evidenceVault","observability","opportunities","portalIntakes","workflowTasks","growthOpportunities","privacyConsents","temporalActions","billingContracts","whatsappSessions","temporalSnapshots","knowledgeEdges"];
 const out={};
 for(const name of names){const raw=db[name];if(Array.isArray(raw)){let prod=0,qa=0;for(const item of raw){const p=classifyRecord(item);if(p.environment==="qa"||p.tenantId==="qa")qa++;else prod++;}out[name]={all:raw.length,production:prod,qa};}else if(raw&&typeof raw==="object"){let prod=0,qa=0;for(const [k,item] of Object.entries(raw)){const p=classifyRecord(item);if(p.environment==="qa"||p.tenantId==="qa")qa++;else prod++;}out[name]={all:Object.keys(raw).length,production:prod,qa};}}
 return out;
}
function operationalArray(name){const a=Array.isArray(db[name])?db[name]:[];return a.filter(isOperationalRecord);}
function operationalObject(name){const o=db[name]&&typeof db[name]==="object"&&!Array.isArray(db[name])?db[name]:{};return Object.fromEntries(Object.entries(o).filter(([,v])=>isOperationalRecord(v)));}
let identityMapCache=null;
function loadIdentityMap(){
  if(identityMapCache)return identityMapCache;
  const raw=String(process.env.RAVEL_IDENTITY_MAP_JSON||"");
  if(!raw)return identityMapCache=[];
  try{
    const parsed=JSON.parse(raw);
    if(!Array.isArray(parsed))throw new Error("identity map must be an array");
    identityMapCache=parsed.filter(x=>x&&typeof x==="object"&&x.keySha256&&x.principalId&&x.tenantId).map(x=>({
      keySha256:String(x.keySha256).toLowerCase(),principalId:String(x.principalId),tenantId:String(x.tenantId),
      roles:Array.isArray(x.roles)?x.roles.map(String).slice(0,32):[]
    }));
    return identityMapCache;
  }catch(e){throw new Error("RAVEL_IDENTITY_MAP_JSON_INVALID: "+e.message)}
}
function identityForKey(key){
  const hash=crypto.createHash("sha256").update(String(key)).digest("hex");
  const mapped=loadIdentityMap().find(x=>x.keySha256===hash);
  return mapped||{keySha256:hash,principalId:"service:ravel-api",tenantId:DEFAULT_TENANT_ID,roles:["service"]};
}
function identityForAdminKey(key){
  const hash=crypto.createHash("sha256").update(String(key)).digest("hex");
  const mapped=loadIdentityMap().find(x=>x.keySha256===hash);
  return mapped||{keySha256:hash,principalId:"admin:ravel",tenantId:"system",roles:["security_admin"]};
}
function productionPreflight(){
 if(!PRODUCTION)return {ok:true,mode:"development"};
 const failures=[];
 const key=String(process.env.RAVEL_API_KEY||"");
 if(key.length<32)failures.push("RAVEL_API_KEY must be at least 32 characters in production");
 const adminKey=String(process.env.RAVEL_ADMIN_API_KEY||"");
 if(adminKey.length<32)failures.push("RAVEL_ADMIN_API_KEY must be at least 32 characters in production");
 if(adminKey&&adminKey===key)failures.push("RAVEL_ADMIN_API_KEY must differ from RAVEL_API_KEY");
 if(PERSISTENCE_BACKEND!=="sqlite"&&!process.env.DATABASE_URL)failures.push("DATABASE_URL is required in production");
 else if(PERSISTENCE_BACKEND!=="sqlite") {try{const u=new URL(process.env.DATABASE_URL);if(u.protocol!=="postgresql:"&&u.protocol!=="postgres:")failures.push("DATABASE_URL must use postgresql:// or postgres://");}catch{failures.push("DATABASE_URL is invalid");}}
 if(PERSISTENCE_BACKEND==="sqlite"){if(!fs.existsSync(SQLITE_ADAPTER))failures.push("SQLite adapter module is missing");}else if(!fs.existsSync(POSTGRES_ADAPTER))failures.push("PostgreSQL adapter module is missing");
 if(!fs.existsSync(path.join(ROOT,"db","001_initial.sql")))failures.push("PostgreSQL migration baseline is missing");
 if(PERSISTENCE_BACKEND!=="sqlite"){try{require.resolve("pg")}catch{failures.push("Node PostgreSQL driver `pg` is not installed");}}
 if(!COOKIE_SECURE)failures.push("COOKIE_SECURE must be true in production");
 try{loadIdentityMap()}catch(e){failures.push(e.message)}
 if(!PUBLIC_ORIGIN)failures.push("RAVEL_PUBLIC_ORIGIN is required in production");
 else {try{const u=new URL(PUBLIC_ORIGIN);if(u.protocol!=="https:")failures.push("RAVEL_PUBLIC_ORIGIN must use https:// in production");}catch{failures.push("RAVEL_PUBLIC_ORIGIN is invalid");}}
 if(failures.length)throw new Error("PRODUCTION_PREFLIGHT_FAILED: "+failures.join("; "));
 return {ok:true,mode:"production"};
}
productionPreflight();
const RATE_WINDOW_MS=60_000, RATE_LIMIT=Number(process.env.RAVEL_TEST_RATE_LIMIT||120), MAX_RATE_BUCKETS=10_000, rateBuckets=new Map();
setInterval(()=>{const now=Date.now();for(const [k,v] of rateBuckets){if(now-v.start>=RATE_WINDOW_MS)rateBuckets.delete(k)}for(const [k,v] of sessions){if((typeof v==="number"?v:v.expiresAt)<=now)sessions.delete(k)}},RATE_WINDOW_MS).unref();
setInterval(()=>{if(PRODUCTION&&productionStore?.pool&&PERSISTENCE_BACKEND!=="sqlite")productionStore.pool.query("DELETE FROM ravel_sessions WHERE expires_at<=now()").catch(e=>console.error("SESSION_CLEANUP_ERROR:",e.message))},RATE_WINDOW_MS).unref();
const PUBLIC_API=new Set(["/api/health","/api/health/ready"]);
function clientKey(q){
  const trustProxy=process.env.TRUST_PROXY==="true";
  return String(trustProxy?(q.headers["x-forwarded-for"]||q.socket.remoteAddress):(q.socket.remoteAddress||"local")).split(",")[0].trim();
}
function parseCookies(q){const raw=String(q.headers.cookie||"");const out={};for(const part of raw.split(";")){const i=part.indexOf("=");if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}return out}
function sessionHash(token){return crypto.createHash("sha256").update(String(token)).digest("hex")}
async function issueSession(identity){
 const token=crypto.randomBytes(32).toString("base64url"),expiresAt=new Date(Date.now()+SESSION_TTL_MS);
 if(PRODUCTION){
   if(!productionStore?.pool)throw new Error("session_store_unavailable");
 }
 if(PRODUCTION){if(PERSISTENCE_BACKEND==="sqlite")productionStore.pool.prepare("INSERT INTO ravel_sessions(token_hash,expires_at,principal_id,tenant_id,roles) VALUES(?,?,?,?,?)").run(sessionHash(token),expiresAt.toISOString(),identity.principalId,identity.tenantId,JSON.stringify(identity.roles||[]));else await productionStore.pool.query("INSERT INTO ravel_sessions(token_hash,expires_at,principal_id,tenant_id,roles) VALUES($1,$2,$3,$4,$5)",[sessionHash(token),expiresAt,identity.principalId,identity.tenantId,JSON.stringify(identity.roles||[])]);}
 sessions.set(token,{expiresAt:expiresAt.getTime(),...identity});
 return token;
}
async function validSession(q){
 const token=parseCookies(q).ravel_session;if(!token)return false;
 if(PRODUCTION){
   if(!productionStore?.pool)return false;
   const rows=PERSISTENCE_BACKEND==="sqlite"?[productionStore.pool.prepare("SELECT principal_id,tenant_id,roles FROM ravel_sessions WHERE token_hash=? AND expires_at>?").get(sessionHash(token),new Date().toISOString())]:(await productionStore.pool.query("SELECT principal_id,tenant_id,roles FROM ravel_sessions WHERE token_hash=$1 AND expires_at>now()",[sessionHash(token)])).rows;
   if(rows.length!==1)return false;
   const roles=PERSISTENCE_BACKEND==="sqlite"?JSON.parse(rows[0].roles||"[]"):rows[0].roles;
   q.authContext={principalId:rows[0].principal_id,tenantId:rows[0].tenant_id,roles:Array.isArray(roles)?roles:[] ,authMethod:"session"};
   return true;
 }
 const session=sessions.get(token);if(!session)return false;if(session.expiresAt<Date.now()){sessions.delete(token);return false}q.authContext={principalId:session.principalId,tenantId:session.tenantId,roles:session.roles||[],authMethod:"session"};return true;
}
async function revokeSession(q){const token=parseCookies(q).ravel_session;if(!token)return;if(PRODUCTION&&productionStore?.pool){if(PERSISTENCE_BACKEND==="sqlite")productionStore.pool.prepare("DELETE FROM ravel_sessions WHERE token_hash=?").run(sessionHash(token));else await productionStore.pool.query("DELETE FROM ravel_sessions WHERE token_hash=$1",[sessionHash(token)]);}sessions.delete(token)}
function csrfAllowed(q){
 const method=String(q.method||"GET").toUpperCase();if(!["POST","PUT","PATCH","DELETE"].includes(method))return true;
 const origin=String(q.headers.origin||"");if(!origin)return false;
 try{
   if(PUBLIC_ORIGIN)return new URL(origin).origin===PUBLIC_ORIGIN;
   return new URL(origin).host===String(q.headers.host||"");
 }catch{return false}
}
function isLoopback(q){const a=String(q.socket?.remoteAddress||"");return a==="127.0.0.1"||a==="::1"||a==="::ffff:127.0.0.1"}
async function authorized(q,p){
 if(PUBLIC_API.has(p))return {ok:true};
 const expected=process.env.RAVEL_API_KEY;
 const sessionCookie=parseCookies(q).ravel_session;
 if(sessionCookie&&["POST","PUT","PATCH","DELETE"].includes(String(q.method||"").toUpperCase())&&!csrfAllowed(q))return {ok:false,csrf:true};
 if(!PRODUCTION&&process.env.RAVEL_LOCAL_TRUSTED!=="false"&&isLoopback(q)){q.authContext={principalId:"local:operator",tenantId:DEFAULT_TENANT_ID,roles:["local","operator"],authMethod:"local_trusted"};return {ok:true,local:true}}
 if(!expected)return {ok:false,misconfigured:true};
 if(await validSession(q)){return {ok:true,session:true}}
 const suppliedRaw=String(q.headers["x-api-key"]||"");const supplied=Buffer.from(suppliedRaw),wanted=Buffer.from(expected);const ok=supplied.length===wanted.length&&crypto.timingSafeEqual(supplied,wanted);if(ok)q.authContext={...identityForKey(suppliedRaw),authMethod:"api_key"};return {ok}
}
function rateOK(q){
 const k=clientKey(q),now=Date.now(),v=rateBuckets.get(k);
 if(!v&&rateBuckets.size>=MAX_RATE_BUCKETS){for(const [rk,rv] of rateBuckets){if(now-rv.start>=RATE_WINDOW_MS)rateBuckets.delete(rk);}}
if(!v||now-v.start>=RATE_WINDOW_MS){rateBuckets.set(k,{start:now,count:1});return true}v.count++;return v.count<=RATE_LIMIT}
function parseQuery(q){return Object.fromEntries(new URL(q.url,"http://localhost").searchParams.entries())}
function safeUrl(target,adapter){try{const u=new URL(target),b=new URL(adapter.base);return u.protocol===b.protocol&&u.hostname===b.hostname&&u.port===b.port}catch{return false}}
function validOfficialDomain(domain){try{const h=new URL(domain.includes("://")?domain:"https://"+domain).hostname.toLowerCase();return ["gov.br","stf.jus.br","stj.jus.br","tst.jus.br","trt7.jus.br","planalto.gov.br","congressonacional.leg.br"].some(d=>h===d||h.endsWith("."+d))}catch{return false}}
function securityHeaders(extra={}){return {"X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"no-referrer","Cross-Origin-Resource-Policy":"same-origin","X-Permitted-Cross-Domain-Policies":"none","Permissions-Policy":"camera=(), microphone=(), geolocation=()",...(PRODUCTION?{"Strict-Transport-Security":"max-age=31536000; includeSubDomains"}:{}),"Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",...extra}}

// PRESERVED_LEGACY_CAPABILITIES_20260905
const marketingOffers=[{slug:"diagnostico-tributario",name:"Diagnóstico Tributário Estratégico",audience:"PMEs e empresas em crescimento",cta:"Solicitar diagnóstico",recurring:false},{slug:"compliance-fiscal",name:"Compliance Fiscal e Contábil",audience:"Empresas com operação recorrente",cta:"Avaliar conformidade",recurring:true},{slug:"auditoria-tributaria",name:"Auditoria Tributária",audience:"Empresas com risco ou potencial de recuperação",cta:"Solicitar auditoria",recurring:false},{slug:"contencioso-administrativo",name:"Contencioso Tributário Administrativo",audience:"Empresas fiscalizadas ou autuadas",cta:"Avaliar caso",recurring:false},{slug:"governanca-fiscal",name:"Governança e Inteligência Fiscal",audience:"Gestores e empresas estruturadas",cta:"Falar com especialista",recurring:true}];
const marketingFunnel=[{stage:"awareness",channels:["SEO","Google Business","LinkedIn","conteúdo técnico","parcerias"],goal:"atrair demanda qualificada"},{stage:"capture",channels:["site","landing pages","WhatsApp","formulário"],goal:"capturar lead com consentimento"},{stage:"qualification",channels:["CRM","triagem","score"],goal:"separar oportunidade de consulta geral"},{stage:"diagnosis",channels:["agenda","documentos","reunião"],goal:"entender problema e escopo"},{stage:"proposal",channels:["proposta digital","follow-up"],goal:"converter oportunidade"},{stage:"delivery",channels:["onboarding","workflow","portal"],goal:"entregar com rastreabilidade"},{stage:"retention",channels:["relatório","revisão periódica","cross-sell"],goal:"transformar projeto em relacionamento recorrente"}];
function validateMarketingContent(input={}){const text=String(input.text||""),lower=text.toLowerCase(),prohibited=["garantia de resultado","resultado garantido","ganhe sua causa","cliente ganhou","cliente recuperou","honorários promocionais","desconto de honorários","consulta grátis","consulta gratuita"],hits=prohibited.filter(x=>lower.includes(x));return {allowed:hits.length===0,status:hits.length===0?"PASS":"BLOCK",hits,checks:{objectiveInformative:true,noPromiseOfResults:hits.every(x=>!x.includes("resultado")),noConcreteCase:hits.every(x=>!x.includes("cliente")),humanReviewRequired:true,sourceAndDateRequired:true},basis:"OAB Provimento 205/2021 — publicidade jurídica informativa, verdadeira, sóbria e sem captação indevida."};}

let db={leads:[{id:"lead_001",name:"Empresa Alfa",company:"Empresa Alfa",origin:"Indicação",problem:"Auditoria ICMS-ST",stage:"Diagnóstico",value:48000}],cases:[{id:"case_001",title:"Fiscalização ICMS-ST",area:"Tributário",risk:"alto",progress:72,status:"Em análise"}],agents:["Orquestrador Master","Tributário Master","Jurídico Master","Contábil Master","Auditor Master","Jurisprudência","Legislação","Contencioso","Português Jurídico","Comercial","Marketing/SEO","Customer Success","Dados/BI","Automação","LGPD/Compliance","Red Team"],workflows:["Lead → Cliente","Auditoria → Recuperação","Fiscalização → Defesa","Lei nova → Cliente"],evidence:[]};

fs.mkdirSync(DATA,{recursive:true});
if(fs.existsSync(STATE_FILE)){
  try{
    const persisted=JSON.parse(fs.readFileSync(STATE_FILE,"utf8"));
    if(!persisted||typeof persisted!=="object"||Array.isArray(persisted))throw new Error("state root must be an object");
    db={...db,...persisted};
  }catch(e){
    console.error("STATE_LOAD_ERROR:",e.message);
    throw new Error("Persistent state is invalid or unreadable: "+e.message);
  }
}
const save=()=>{
  const tmp=STATE_FILE+".tmp";
  try{
    const serialized=JSON.stringify(db,null,2);
    if(Buffer.byteLength(serialized,"utf8")>MAX_STATE_BYTES)throw new Error("state_size_limit_exceeded");
    fs.writeFileSync(tmp,serialized,"utf8");
    try{fs.renameSync(tmp,STATE_FILE)}
    catch(e){
      if(!["EEXIST","EPERM","ENOTEMPTY"].includes(e.code))throw e;
      fs.rmSync(STATE_FILE,{force:true});
      fs.renameSync(tmp,STATE_FILE);
    }
    return true;
  }catch(e){
    try{if(fs.existsSync(tmp))fs.unlinkSync(tmp)}catch(_){}
    console.error("STATE_PERSISTENCE_ERROR:",e.message);
    return false;
  }
}
const persistOrThrow=()=>{
 if(!PRODUCTION){if(!save())throw new Error("state_persistence_failed");return;}
 persistenceDirty=true;persistenceRevision++;
};
const flushProductionPersistence=async()=>{
 if(!PRODUCTION||!persistenceDirty||!productionStore)return;
 persistenceFlush=persistenceFlush.then(async()=>{
   while(persistenceDirty){
     const revision=persistenceRevision;
     const snapshot=JSON.parse(JSON.stringify(db));
     persistenceVersion=await require(PERSISTENCE_BACKEND==="sqlite"?SQLITE_ADAPTER:POSTGRES_ADAPTER).saveState(productionStore.pool,snapshot,persistenceVersion);
     if(revision===persistenceRevision)persistenceDirty=false;
   }
 });
 return persistenceFlush;
};
const id=p=>p+"_"+crypto.randomBytes(5).toString("hex");
function fileSha256(file){try{return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}catch{return null}}
function dataMode(){return String(process.env.RAVEL_DATA_MODE||"production_strict").toLowerCase()}
function syntheticText(v){return JSON.stringify(v??"").toLowerCase()}
function isSyntheticRecord(v){
 const t=syntheticText(v);
 return ["qa-client","qa opportunity","runtime_self_test","evidência de teste","\"qa\"","\"test\"","\"teste\"","controlled-validation-test","teste controlado","controlado"].some(m=>t.includes(m));
}
function partitionArray(a){
 const arr=Array.isArray(a)?a:[];
 const qa=arr.filter(isSyntheticRecord), production=arr.filter(v=>!isSyntheticRecord(v));
 return {all:arr,production,qa,mode:dataMode(),counts:{all:arr.length,production:production.length,qa:qa.length}};
}
function partitionObject(o){
 const all=o&&typeof o==="object"&&!Array.isArray(o)?o:{};
 const production={};const qa={};
 for(const [k,v] of Object.entries(all)){if(isSyntheticRecord(v))qa[k]=v;else production[k]=v}
 return {all,production,qa,mode:dataMode(),counts:{all:Object.keys(all).length,production:Object.keys(production).length,qa:Object.keys(qa).length}};
}
function visibleArray(a){return dataMode()==="qa_mixed"?(Array.isArray(a)?a:[]):partitionArray(a).production}
function visibleObject(o){return dataMode()==="qa_mixed"?(o||{}):partitionObject(o).production}

function regressionVerified(){try{const v=JSON.parse(fs.readFileSync(RELEASE_VERIFY_FILE,"utf8"));return v.serverSha256===fileSha256(path.join(ROOT,"server.js"))&&v.smokeSha256===fileSha256(path.join(ROOT,"test","smoke.sh"))&&v.securitySha256===fileSha256(path.join(ROOT,"test","security_redteam.sh"))&&v.result==="PASS"}catch{return false}}
const out=async(r,s,x)=>{
  if(PRODUCTION){
    try{await flushProductionPersistence()}catch(e){
      persistenceFailure=e;
      console.error("PERSISTENCE_FLUSH_ERROR:",e.message);
      if(!r.headersSent&&!r.destroyed){r.writeHead(503,securityHeaders({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Connection":"close"}));r.end(JSON.stringify({error:"persistence_unavailable",message:"Persistent storage is temporarily unavailable."}));}
      return false;
    }
  }
  if(r.headersSent||r.destroyed)return false;
  r.writeHead(s,securityHeaders({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}));
  r.end(JSON.stringify(x));
  return true;
};
const body=q=>new Promise((ok,no)=>{
 let b="",size=0,done=false;
 const declared=Number(q.headers["content-length"]||0);
 if(Number.isFinite(declared)&&declared>MAX_BODY_BYTES){done=true;const e=new Error("request_body_too_large");e.code="REQUEST_BODY_TOO_LARGE";q.resume();no(e);return;}
 const fail=e=>{if(!done){done=true;no(e)}};
 q.on("data",c=>{
   if(done)return;
   size+=c.length;
   if(size>MAX_BODY_BYTES){
     done=true;const e=new Error("request_body_too_large");e.code="REQUEST_BODY_TOO_LARGE";no(e);q.resume();return;
   }
   b+=c;
 });
 q.on("end",()=>{if(done)return;done=true;try{ok(b?JSON.parse(b):{})}catch(e){e.code="INVALID_JSON";no(e)}});
 q.on("error",fail);
}); 
async function route(q,r){
 const u=new URL(q.url,"http://localhost"),p=u.pathname;q.query=parseQuery(q);
 try{
  if(!rateOK(q))return out(r,429,{error:"rate_limit_exceeded"});
  if(q.method==="POST"&&p==="/api/auth/login")return body(q).then(async x=>{
    const expected=process.env.RAVEL_API_KEY;if(!expected)return out(r,503,{error:"auth_not_configured"});
    const supplied=Buffer.from(String(x.apiKey||"")),wanted=Buffer.from(expected);
    if(supplied.length!==wanted.length||!crypto.timingSafeEqual(supplied,wanted))return out(r,401,{error:"unauthorized"});
    const identity=identityForKey(String(x.apiKey||""));
    const token=await issueSession(identity);
    r.writeHead(200,securityHeaders({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Set-Cookie":"ravel_session="+encodeURIComponent(token)+"; HttpOnly; SameSite=Strict; Path=/; Max-Age="+Math.floor(SESSION_TTL_MS/1000)+(COOKIE_SECURE?"; Secure":"")}));
    return r.end(JSON.stringify({authenticated:true,expiresAt:new Date(Date.now()+SESSION_TTL_MS).toISOString()}));
  });
  if(q.method==="POST"&&p==="/api/auth/logout")return body(q).then(async ()=>{if(!csrfAllowed(q))return out(r,403,{error:"csrf_rejected"});await revokeSession(q);r.writeHead(200,securityHeaders({"Content-Type":"application/json; charset=utf-8","Set-Cookie":"ravel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"+(COOKIE_SECURE?"; Secure":"")}));r.end(JSON.stringify({authenticated:false}));});
  // Web shell is public; API authorization remains fail-closed.
  // Authentication happens through /api/auth/login and establishes the HttpOnly session.
  const publicWeb = (q.method === "GET" || q.method === "HEAD") && !p.startsWith("/api/");
  if(!publicWeb){
    const auth=await authorized(q,p);
    if(auth.misconfigured)return out(r,503,{error:"auth_not_configured",hint:"RAVEL_API_KEY must be configured for protected API routes."});
    if(auth.csrf)return out(r,403,{error:"csrf_rejected"});
    if(!auth.ok)return out(r,401,{error:"unauthorized",hint:"Use X-API-Key when RAVEL_API_KEY is configured."});
    const authenticatedTenant=String(q.authContext?.tenantId||DEFAULT_TENANT_ID);
    if(authenticatedTenant!==DEFAULT_TENANT_ID)return out(r,403,{error:"tenant_isolation_not_certified",tenantId:authenticatedTenant,policy:"single_tenant_fail_closed"});
  }
  if(q.method==="GET"&&p==="/api/security/context")return out(r,200,{principalId:q.authContext?.principalId||null,tenantId:q.authContext?.tenantId||null,roles:q.authContext?.roles||[],authMethod:q.authContext?.authMethod||null});
if(q.method==="GET"&&p==="/api/data-quality/partition")return out(r,200,{mode:"production_strict",tenant:q.authContext?.tenantId||DEFAULT_TENANT_ID,defaultEnvironment:DEFAULT_ENVIRONMENT,collections:partitionCollections(),policy:"operational endpoints exclude qa/test/synthetic records by default; historical records preserved"});
  if(q.method==="GET"&&p==="/api/data-quality/partition")return out(r,200,(()=>{
 const names=["leads","tasks","clients","crmLeads","evidence","contracts","proposals","engagements","factoryDocs","caseContexts","deliverables","juntaQueue","liveAlerts","agentMemory","agentOutcomes","evidenceVault","observability","opportunities","portalIntakes","workflowTasks","growthOpportunities","privacyConsents","temporalActions","billingContracts","whatsappSessions","temporalSnapshots","knowledgeEdges"];
 const result={mode:dataMode(),collections:[]};
 for(const name of names){const v=db[name];const part=Array.isArray(v)?partitionArray(v):partitionObject(v);result.collections.push({collection:name,counts:part.counts});}
 return result;
})());
if(q.method==="GET"&&p==="/api/production/readiness")return out(r,PRODUCTION?(productionStore?.pool?200:503):200,{ok:!PRODUCTION||Boolean(productionStore?.pool),mode:PRODUCTION?"production":"local",persistence:PRODUCTION?(productionStore?.pool?PERSISTENCE_BACKEND:"unavailable"):"local_json",productionCredentials:PRODUCTION,externalConnectorsRequired:PRODUCTION});
  if(q.method==="GET"&&p==="/api/release/operational-readiness")return out(r,200,{status:PRODUCTION?(productionStore?.pool?"ready_for_runtime":"blocked"):"operational_local",mode:PRODUCTION?"production":"local",checks:{http:true,persistence:PRODUCTION?Boolean(productionStore?.pool):true,localState:!PRODUCTION},blocking:PRODUCTION&&!productionStore?.pool?[PERSISTENCE_BACKEND]:[]});
  if(q.method==="POST"&&p==="/api/next")return body(q).then(x=>{
  const stages=[
    {id:"foundation",name:"Fundação Empresarial",status:"completed"},
    {id:"research",name:"Pesquisa Aprofundada",status:"completed"},
    {id:"integrations",name:"Integrações",status:"completed"},
    {id:"production",name:"Produção Real",status:"next"},
    {id:"growth",name:"Aquisição e Crescimento",status:"queued"},
    {id:"scale",name:"Escala e Inteligência",status:"queued"}
  ];
  const current=x.currentStage||"integrations";
  const idx=Math.max(0,stages.findIndex(s=>s.id===current));
  const next=stages[Math.min(idx+1,stages.length-1)];
  return out(r,200,{command:"proxima",currentStage:current,nextStage:next,agent:"NextStage Orchestrator",actions:{
    plan:["auditar estado atual","selecionar módulos da próxima fase","implementar","testar","corrigir","entregar"],
    rule:"Avançar sem pedir confirmação quando o comando for PROXIMA."
  }});
});
if(q.method==="POST"&&p==="/api/intake")return body(q).then(x=>{
  const lead={id:id("lead"),name:x.name||"Novo contato",company:x.company||"",contact:x.contact||"",origin:x.origin||"site",problem:x.problem||"",stage:"Novo",createdAt:new Date().toISOString()};
  db.leads.push(lead);persistOrThrow();
  return out(r,201,{accepted:true,lead,route:["triage","commercial","diagnostic"],sla:"next_business_action"});
});
if(q.method==="GET"&&p==="/api/tasks")return out(r,200,db.tasks||[]);
if(q.method==="POST"&&p==="/api/tasks")return body(q).then(x=>{
  db.tasks=db.tasks||[];const t={id:id("task"),title:x.title||"Tarefa",agent:x.agent||"Orquestrador Master",priority:x.priority||"normal",status:"queued",createdAt:new Date().toISOString()};db.tasks.push(t);persistOrThrow();return out(r,201,t)
});
if(q.method==="POST"&&p==="/api/agents/execute")return body(q).then(x=>{
  db.tasks=db.tasks||[];const t={id:id("run"),title:x.task||"Execução",agent:x.agent||"Orquestrador Master",status:"queued",steps:["context","plan","execute","quality_gate","deliver"],queuedAt:new Date().toISOString()};db.tasks.push(t);persistOrThrow();return out(r,202,{run:t,qualityGate:"pending",humanReviewRequired:x.critical===true,next:["worker_execution","quality_gate","human_review_if_critical"]})
});
if(q.method==="GET"&&p==="/api/growth/funnel")return out(r,200,{channels:["site","WhatsApp","indicação","conteúdo","parcerias","pesquisa orgânica"],stages:["visitante","lead","triagem","diagnóstico","proposta","cliente","recorrência","expansão"],principle:"medir aquisição → conversão → ticket → retenção"});
if(q.method==="GET"&&p==="/api/production/board")return out(r,200,{lanes:["Entrada","Diagnóstico","Pesquisa","Produção","Red Team","Revisão","Entrega","Recorrência"],qualityGates:["fonte","vigência","evidência","contraditório","risco","revisão"]});
if(q.method==="GET"&&p==="/api/junta/status")return out(r,200,{
  name:"Junta Autônoma de Operações",
  chairman:"CEO / Orquestrador Master",
  agents:db.agents.map((name,i)=>({name,status:"registered",availability:"ready",specialty:["estratégia","tributário","jurídico","contábil","auditoria","jurisprudência","legislação","contencioso","red team","comercial","marketing","dados","automação","compliance","customer success"][i]||"especialista"})),
  principles:["evidência antes de conclusão","fonte primária quando disponível","contraditório","priorização por valor/risco/prazo","revisão humana em decisões críticas"]
});
if(q.method==="GET"&&p==="/api/junta/queue")return out(r,200,(db.juntaQueue||[]));
if(q.method==="POST"&&p==="/api/junta/dispatch")return body(q).then(x=>{
  db.juntaQueue=db.juntaQueue||[];
  const priority=Number(x.value||0)*2+Number(x.risk||0)*3+Number(x.urgency||0)*2;
  const job={id:id("junta"),request:x.request||"Nova demanda",agent:x.agent||"Orquestrador Master",priority,status:"dispatched",steps:["triagem","especialistas","evidências","Red Team","decisão","entrega"],createdAt:new Date().toISOString()};
  db.juntaQueue.push(job);persistOrThrow();return out(r,201,job)
});
if(q.method==="POST"&&p==="/api/junta/decide")return body(q).then(x=>{
  const score=Number(x.value||0)*2+Number(x.risk||0)*3+Number(x.urgency||0)*2;
  const decision=score>=15?"EXECUTAR_AGORA":score>=8?"PRIORIZAR":"PROGRAMAR";
  return out(r,200,{decision,score,criteria:{value:x.value||0,risk:x.risk||0,urgency:x.urgency||0},next:["validar fatos","selecionar agentes","buscar evidências","red-team","revisão humana","entrega"]})
});
if(q.method==="POST"&&p==="/api/memory/client")return body(q).then(x=>{
  db.clientMemory=db.clientMemory||{};
  const key=x.clientId||id("client");
  db.clientMemory[key]={clientId:key,company:x.company||"",context:x.context||"",objectives:x.objectives||[],risks:x.risks||[],updatedAt:new Date().toISOString()};
  persistOrThrow();return out(r,201,db.clientMemory[key])
});
if(q.method==="GET"&&p==="/api/memory/client")return out(r,200,db.clientMemory||{});
if(q.method==="POST"&&p==="/api/enterprise/onboard")return body(q).then(x=>{
  db.clients=db.clients||{};db.engagements=db.engagements||[];
  const clientId=x.clientId||id("client");
  const client={clientId,company:x.company||"Novo cliente",contact:x.contact||"",segment:x.segment||"Tributário/Contábil/Jurídico",status:"onboarding",createdAt:new Date().toISOString()};
  db.clients[clientId]=client;
  const engagement={id:id("eng"),clientId,service:x.service||"Diagnóstico Estratégico",stage:"diagnóstico",pipeline:["onboarding","diagnóstico","proposta","contratação","produção","revisão","entrega","recorrência"],owner:"Orquestrador Master",createdAt:new Date().toISOString()};
  db.engagements.push(engagement);persistOrThrow();
  return out(r,201,{client,engagement,next:["coleta documental","Cenário Zero","diagnóstico","proposta"]})
});
if(q.method==="GET"&&p==="/api/enterprise/pipeline")return out(r,200,{clients:db.clients||{},engagements:db.engagements||[],stages:["onboarding","diagnóstico","proposta","contratação","produção","revisão","entrega","recorrência"]});
if(q.method==="POST"&&p==="/api/enterprise/engagement")return body(q).then(x=>{
  db.engagements=db.engagements||[];
  const e={id:id("eng"),clientId:x.clientId,service:x.service||"Projeto",stage:x.stage||"diagnóstico",value:Number(x.value||0),deadline:x.deadline||null,owner:x.owner||"Orquestrador Master",createdAt:new Date().toISOString()};
  db.engagements.push(e);persistOrThrow();return out(r,201,e)
});
if(q.method==="POST"&&p==="/api/enterprise/proposal")return body(q).then(x=>{
  const proposal={id:id("proposal"),clientId:x.clientId,service:x.service||"Consultoria",scope:x.scope||[],value:Number(x.value||0),recurrence:Number(x.recurrence||0),status:"draft",commercialNext:["revisar escopo","validar preço","enviar ao cliente"],createdAt:new Date().toISOString()};
  db.proposals=db.proposals||[];db.proposals.push(proposal);persistOrThrow();return out(r,201,proposal)
});
if(q.method==="POST"&&p==="/api/enterprise/deliverable")return body(q).then(x=>{
  const d={id:id("deliverable"),clientId:x.clientId,engagementId:x.engagementId,type:x.type||"Relatório",title:x.title||"Entrega Ravel 360",status:"ready_for_review",qualityGates:["fontes","vigência","evidências","contraditório","Red Team","revisão humana"],createdAt:new Date().toISOString()};
  db.deliverables=db.deliverables||[];db.deliverables.push(d);persistOrThrow();return out(r,201,d)
});
if(q.method==="GET"&&p==="/api/enterprise/revenue")return out(r,200,{model:["projeto","mensalidade","recuperação","planejamento","auditoria","contencioso","treinamento"],metrics:{pipelineValue:(db.engagements||[]).reduce((a,e)=>a+Number(e.value||0),0),recurringValue:(db.proposals||[]).reduce((a,e)=>a+Number(e.recurrence||0),0),clients:Object.keys(db.clients||{}).length}});
if(q.method==="POST"&&p==="/api/intelligence/profile")return body(q).then(x=>{
  db.intelligence=db.intelligence||{};
  const clientId=x.clientId||id("client");
  const profile={clientId,company:x.company||"",sector:x.sector||"",state:x.state||"CE",activities:x.activities||[],taxThemes:x.taxThemes||[],systems:x.systems||[],knownRisks:x.knownRisks||[],opportunities:x.opportunities||[],documents:x.documents||[],updatedAt:new Date().toISOString()};
  db.intelligence[clientId]=profile;persistOrThrow();return out(r,201,profile)
});
if(q.method==="GET"&&p==="/api/intelligence/profile")return out(r,200,db.intelligence||{});
if(q.method==="POST"&&p==="/api/intelligence/radar")return body(q).then(x=>{
  const profile=(db.intelligence||{})[x.clientId]||x.profile||{};
  const signals=[];
  if((profile.taxThemes||[]).length)signals.push({type:"tributário",priority:"alta",reason:"temas tributários informados no perfil"});
  if((profile.knownRisks||[]).length)signals.push({type:"risco",priority:"alta",reason:"riscos declarados exigem validação"});
  if((profile.documents||[]).length===0)signals.push({type:"documental",priority:"média",reason:"ausência de documentos estruturados"});
  if((profile.systems||[]).length)signals.push({type:"dados/ERP",priority:"média",reason:"sistemas podem alimentar auditoria"});
  return out(r,200,{clientId:x.clientId,signals,agents:["Tributário Master","Auditor Master","Dados/BI","Jurisprudência","Legislação","Red Team"],next:["validar sinal","buscar fonte primária","quantificar oportunidade","red-team","propor ação"]})
});
if(q.method==="POST"&&p==="/api/intelligence/opportunity")return body(q).then(x=>{
  db.opportunities=db.opportunities||[];
  const o={id:id("opp"),clientId:x.clientId,type:x.type||"oportunidade tributária",title:x.title||"Oportunidade identificada",estimatedValue:Number(x.estimatedValue||0),confidence:Number(x.confidence||0),evidence:x.evidence||[],status:"needs_validation",next:["validar fatos","validar legislação","quantificar","decidir abordagem"],createdAt:new Date().toISOString()};
  db.opportunities.push(o);persistOrThrow();return out(r,201,o)
});
if(q.method==="GET"&&p==="/api/intelligence/opportunities")return out(r,200,db.opportunities||[]);
if(q.method==="GET"&&p==="/api/research/live/sources")return out(r,200,{sources:[
  {id:"planalto",name:"Planalto",type:"legislacao",url:"https://www.planalto.gov.br",status:"registered"},
  {id:"stf",name:"STF",type:"jurisprudencia",url:"https://portal.stf.jus.br",status:"registered"},
  {id:"stj",name:"STJ",type:"jurisprudencia",url:"https://www.stj.jus.br",status:"registered"},
  {id:"trt7",name:"TRT 7",type:"jurisprudencia",url:"https://www.trt7.jus.br",status:"registered"},
  {id:"sefazce",name:"SEFAZ Ceará",type:"fiscal",url:"https://www.sefaz.ce.gov.br",status:"registered"},
  {id:"receitafederal",name:"Receita Federal",type:"fiscal",url:"https://www.gov.br/receitafederal",status:"registered"},
  {id:"congressonacional",name:"Congresso Nacional",type:"legislacao",url:"https://www.congressonacional.leg.br",status:"registered"}
],policy:"priorizar fonte oficial; registrar data; preservar URL; validar vigência e contexto"});
if(q.method==="POST"&&p==="/api/research/live/query")return body(q).then(async x=>{
  const qtext=String(x.query||"").trim(); if(!qtext)return out(r,400,{error:"query_required"});
  const sources=x.sources||["planalto","stf","stj","sefazce","receitafederal"];
  const searchLinks=sources.map(s=>({source:s,query:qtext,status:"queued",requiresFetcher:true}));
  const result={id:id("live"),query:qtext,sources:searchLinks,createdAt:new Date().toISOString(),status:"evidence_pending",next:["fetch official sources","capture publication date","validate vigency","cross-check","Red Team"]};
  db.liveResearch=db.liveResearch||[];db.liveResearch.push(result);persistOrThrow();return out(r,201,result)
});
if(q.method==="GET"&&p==="/api/research/live/runs")return out(r,200,db.liveResearch||[]);
if(q.method==="POST"&&p==="/api/research/live/evidence")return body(q).then(x=>{
  db.evidence=db.evidence||[];
  const e={id:id("evidence"),researchId:x.researchId,source:x.source,url:x.url||"",title:x.title||"",publishedAt:x.publishedAt||null,accessedAt:new Date().toISOString(),excerpt:x.excerpt||"",status:"captured",verification:["source_identity","date","context","vigency"]};
  db.evidence.push(e);persistOrThrow();return out(r,201,e)
});
if(q.method==="GET"&&p==="/api/research/live/evidence")return out(r,200,db.evidence||[]);
const LIVE_ADAPTERS={
  planalto:{name:"Planalto",base:"https://www.planalto.gov.br",allowed:["https://www.planalto.gov.br"]},
  stf:{name:"STF",base:"https://portal.stf.jus.br",allowed:["https://portal.stf.jus.br"]},
  stj:{name:"STJ",base:"https://www.stj.jus.br",allowed:["https://www.stj.jus.br"]},
  trt7:{name:"TRT 7",base:"https://www.trt7.jus.br",allowed:["https://www.trt7.jus.br"]},
  sefazce:{name:"SEFAZ Ceará",base:"https://www.sefaz.ce.gov.br",allowed:["https://www.sefaz.ce.gov.br"]},
  receitafederal:{name:"Receita Federal",base:"https://www.gov.br/receitafederal",allowed:["https://www.gov.br/receitafederal"]},
  congressonacional:{name:"Congresso Nacional",base:"https://www.congressonacional.leg.br",allowed:["https://www.congressonacional.leg.br"]}
};
if(q.method==="GET"&&p==="/api/research/live/adapters")return out(r,200,Object.entries(LIVE_ADAPTERS).map(([id,a])=>({id,...a,status:"network_fetch_available"})));
if(q.method==="POST"&&p==="/api/research/live/fetch")return body(q).then(async x=>{
  const a=LIVE_ADAPTERS[x.source]; if(!a)return out(r,400,{error:"source_not_allowed"});
  const target=String(x.url||a.base); if(!safeUrl(target,a))return out(r,400,{error:"url_not_allowed"});
  const started=Date.now(); let status="fetch_failed",httpStatus=null,bytes=0,contentHash=null,error=null;
  try{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),Number(process.env.RESEARCH_FETCH_TIMEOUT_MS||15000));
const resp=await fetch(target,{redirect:"manual",signal:controller.signal,headers:{"User-Agent":"Ravel360-ResearchBot/1.0"}});
clearTimeout(timeout);httpStatus=resp.status;if(resp.status>=300&&resp.status<400)return out(r,502,{error:"redirect_blocked",httpStatus,location:resp.headers.get("location")});const declared=Number(resp.headers.get("content-length")||0);
if(declared>MAX_FETCH_RESPONSE_BYTES)throw Object.assign(new Error("response_too_large"),{code:"FETCH_RESPONSE_TOO_LARGE"});
const reader=resp.body?.getReader();let chunks=[],total=0;
if(reader){for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>MAX_FETCH_RESPONSE_BYTES)throw Object.assign(new Error("response_too_large"),{code:"FETCH_RESPONSE_TOO_LARGE"});chunks.push(Buffer.from(part.value))}const buf=Buffer.concat(chunks);bytes=buf.length;contentHash=crypto.createHash("sha256").update(buf).digest("hex")}
else{const buf=Buffer.from(await resp.arrayBuffer());if(buf.length>MAX_FETCH_RESPONSE_BYTES)throw Object.assign(new Error("response_too_large"),{code:"FETCH_RESPONSE_TOO_LARGE"});bytes=buf.length;contentHash=crypto.createHash("sha256").update(buf).digest("hex")}
status=resp.ok?"fetched":"http_error" }catch(e){error=String(e.message||e);status=e.name==="AbortError"?"fetch_timeout":e.code==="FETCH_RESPONSE_TOO_LARGE"?"response_too_large":status}
  db.liveFetches=db.liveFetches||[];
  const snap={id:id("fetch"),source:x.source,url:target,status,httpStatus,bytes,contentHash,durationMs:Date.now()-started,accessedAt:new Date().toISOString(),error};
  const previous=db.liveFetches.find(v=>v.source===x.source&&v.url===target);
  snap.changed=!!(previous&&previous.contentHash&&contentHash&&previous.contentHash!==contentHash);
  db.liveFetches.push(snap);persistOrThrow();return out(r,status==="fetched"?200:502,snap)
});
if(q.method==="GET"&&p==="/api/research/live/fetches")return out(r,200,db.liveFetches||[]);
if(q.method==="POST"&&p==="/api/research/live/alert")return body(q).then(x=>{
  db.liveAlerts=db.liveAlerts||[];const alert={id:id("alert"),source:x.source||"",type:x.type||"change",severity:x.severity||"medium",message:x.message||"Mudança detectada",status:"queued",createdAt:new Date().toISOString()};db.liveAlerts.push(alert);persistOrThrow();return out(r,201,alert)
});
if(q.method==="GET"&&p==="/api/research/live/alerts")return out(r,200,db.liveAlerts||[]);
if(q.method==="POST"&&p==="/api/research/temporal/snapshot")return body(q).then(x=>{
  db.temporalSnapshots=db.temporalSnapshots||[];
  const content=String(x.content||"");const hash=crypto.createHash("sha256").update(content).digest("hex");
  const previous=[...db.temporalSnapshots].reverse().find(v=>v.source===x.source&&v.url===x.url);
  const snap={id:id("ts"),source:x.source||"",url:x.url||"",title:x.title||"",content,hash,publishedAt:x.publishedAt||null,capturedAt:new Date().toISOString(),previousHash:previous?.hash||null,changed:!!(previous&&previous.hash!==hash)};
  db.temporalSnapshots.push(snap);persistOrThrow();return out(r,201,{...snap,content:undefined})
});
if(q.method==="GET"&&p==="/api/research/temporal/snapshots")return out(r,200,(db.temporalSnapshots||[]).map(v=>({...v,content:undefined})));
if(q.method==="POST"&&p==="/api/research/temporal/analyze")return body(q).then(x=>{
  const now=String(x.current||""),old=String(x.previous||"");
  const oldSet=new Set(old.split(/\n+/).map(s=>s.trim()).filter(Boolean));
  const newSet=new Set(now.split(/\n+/).map(s=>s.trim()).filter(Boolean));
  const added=[...newSet].filter(s=>!oldSet.has(s)),removed=[...oldSet].filter(s=>!newSet.has(s));
  const text=(added.join(" ")+" "+removed.join(" ")).toLowerCase();
  const tags=[];
  if(/lei|decreto|medida provisória|portaria|instrução normativa|convênio|resolução/.test(text))tags.push("legislativa/regulatória");
  if(/stf|stj|súmula|tema|acórdão|decisão|precedente/.test(text))tags.push("jurisprudencial");
  if(/icms|iss|ipi|pis|cofins|ibs|cbs|tribut/.test(text))tags.push("tributária");
  if(/fiscal|efd|sped|auto de infração|obrigaç/.test(text))tags.push("fiscal/compliance");
  const severity=tags.length>=2||added.length>=5?"alta":(tags.length||added.length?"média":"baixa");
  return out(r,200,{changed:added.length>0||removed.length>0,added,removed,tags,severity,impactCandidates:["vigência","obrigações acessórias","carga tributária","contencioso","processos internos","clientes afetados"],next:["validar fonte","confirmar vigência","identificar escopo","quantificar impacto","Red Team","decidir ação"]})
});
if(q.method==="POST"&&p==="/api/research/temporal/match")return body(q).then(x=>{
  const profiles=Object.values(db.intelligence||{});const text=(x.text||"").toLowerCase();
  const matches=profiles.filter(p=>[...(p.taxThemes||[]),...(p.activities||[]),...(p.systems||[]),...(p.knownRisks||[])].some(v=>text.includes(String(v).toLowerCase())));
  return out(r,200,{matches:matches.map(p=>({clientId:p.clientId,company:p.company,reasons:[...(p.taxThemes||[]),...(p.activities||[]),...(p.knownRisks||[])].filter(v=>text.includes(String(v).toLowerCase()))})),count:matches.length})
});
if(q.method==="POST"&&p==="/api/research/temporal/action")return body(q).then(x=>{
  db.temporalActions=db.temporalActions||[];
  const a={id:id("ta"),researchId:x.researchId||null,clientId:x.clientId||null,action:x.action||"Validar impacto",priority:x.priority||"alta",owner:x.owner||"Junta Autônoma",status:"queued",createdAt:new Date().toISOString()};
  db.temporalActions.push(a);persistOrThrow();return out(r,201,a)
});
if(q.method==="GET"&&p==="/api/research/temporal/actions")return out(r,200,db.temporalActions||[]);
if(q.method==="POST"&&p==="/api/intelligence/impact/score")return body(q).then(x=>{
  const economic=Number(x.economic||0),urgency=Number(x.urgency||0),exposure=Number(x.exposure||0),confidence=Number(x.confidence||0),legalRisk=Number(x.legalRisk||0);
  const score=Math.round(economic*0.30+urgency*0.20+exposure*0.20+confidence*0.10+legalRisk*0.20);
  const priority=score>=80?"P1":score>=60?"P2":score>=40?"P3":"P4";
  const services=[];
  if(exposure>=60)services.push("Auditoria");
  if(economic>=60)services.push("Planejamento Tributário");
  if(legalRisk>=60)services.push("Contencioso/Legal");
  if(services.length===0)services.push("Diagnóstico");
  return out(r,200,{score,priority,services,drivers:{economic,urgency,exposure,confidence,legalRisk},next:["validar evidências","quantificar impacto","Red Team","aprovar abordagem","acionar cliente"]})
});
if(q.method==="POST"&&p==="/api/intelligence/impact/match")return body(q).then(x=>{
  const profiles=Object.values(db.intelligence||{});const text=String(x.text||"").toLowerCase();
  const matches=profiles.map(p=>{const terms=[...(p.taxThemes||[]),...(p.activities||[]),...(p.knownRisks||[])];const reasons=terms.filter(v=>text.includes(String(v).toLowerCase()));return {clientId:p.clientId,company:p.company,reasons,relevance:Math.min(100,reasons.length*25)}}).filter(v=>v.relevance>0).sort((a,b)=>b.relevance-a.relevance);
  return out(r,200,{matches,ranked:true})
});
if(q.method==="POST"&&p==="/api/crm/inbound")return body(q).then(x=>{
  db.crmLeads=db.crmLeads||[];
  const lead={id:id("lead"),channel:x.channel||"site",name:x.name||"",contact:x.contact||"",company:x.company||"",message:x.message||"",intent:x.intent||"consultoria",status:"new",createdAt:new Date().toISOString()};
  db.crmLeads.push(lead);persistOrThrow();return out(r,201,{lead,next:["qualificar","identificar serviço","avaliar urgência","rotear Junta","follow-up"]})
});
if(q.method==="POST"&&p==="/api/crm/qualify")return body(q).then(x=>{
  const fit=Number(x.fit||0),urgency=Number(x.urgency||0),value=Number(x.value||0),clarity=Number(x.clarity||0);
  const score=Math.round(fit*.30+urgency*.20+value*.30+clarity*.20);
  const tier=score>=80?"A":score>=60?"B":score>=40?"C":"D";
  return out(r,200,{score,tier,route:tier==="A"?"Junta + Comercial Master":tier==="B"?"Comercial + Especialista":"Nutrição/qualificação",next:["registrar CRM","agendar contato","diagnóstico","proposta"]})
});
if(q.method==="GET"&&p==="/api/crm/inbound")return out(r,200,db.crmLeads||{});
if(q.method==="POST"&&p==="/api/factory/document")return body(q).then(x=>{
  db.factoryDocs=db.factoryDocs||[];
  const d={id:id("doc"),clientId:x.clientId||null,type:x.type||"Relatório",title:x.title||"Documento Ravel 360",facts:x.facts||[],issues:x.issues||[],sources:x.sources||[],draft:x.draft||"",status:"quality_gate",gates:{fatos:false,fontes:false,vigencia:false,contraditorio:false,redTeam:false,revisaoHumana:false},createdAt:new Date().toISOString()};
  db.factoryDocs.push(d);persistOrThrow();return out(r,201,d)
});
if(q.method==="POST"&&p==="/api/factory/gate")return body(q).then(x=>{
  db.factoryDocs=db.factoryDocs||[];const d=db.factoryDocs.find(v=>v.id===x.documentId);if(!d)return out(r,404,{error:"document_not_found"});
  const allowed=["fatos","fontes","vigencia","contraditorio","redTeam","revisaoHumana"];if(!allowed.includes(x.gate))return out(r,400,{error:"gate_invalid"});
  d.gates[x.gate]=!!x.pass;d.status=Object.values(d.gates).every(Boolean)?"approved":"quality_gate";d.updatedAt=new Date().toISOString();persistOrThrow();return out(r,200,d)
});
if(q.method==="GET"&&p==="/api/factory/documents")return out(r,200,visibleArray(db.factoryDocs));
if(q.method==="POST"&&p==="/api/finance/contract")return body(q).then(x=>{
  db.contracts=db.contracts||[];
  const c={id:id("contract"),clientId:x.clientId||null,service:x.service||"Consultoria",setup:Number(x.setup||0),monthly:Number(x.monthly||0),successFee:Number(x.successFee||0),cost:Number(x.cost||0),status:"active",createdAt:new Date().toISOString()};
  db.contracts.push(c);persistOrThrow();return out(r,201,c)
});
if(q.method==="GET"&&p==="/api/finance/dashboard")return out(r,200,(()=>{
  const cs=db.contracts||[];const mrr=cs.reduce((a,c)=>a+Number(c.monthly||0),0);const setup=cs.reduce((a,c)=>a+Number(c.setup||0),0);const costs=cs.reduce((a,c)=>a+Number(c.cost||0),0);
  return {contracts:cs.length,mrr,setupRevenue:setup,estimatedGrossMargin:mrr?Math.round((mrr-costs)/mrr*100):0,services:["mensalidade","projeto","success fee","recuperação","auditoria","planejamento","contencioso"]};
})());
if(q.method==="POST"&&p==="/api/governance/audit")return body(q).then(x=>{
  db.auditTrail=db.auditTrail||[];
  const a={id:id("audit"),actor:q.authContext?.principalId||"unknown",tenantId:q.authContext?.tenantId||"system",action:x.action||"unknown",resource:x.resource||"",resourceId:x.resourceId||null,reason:x.reason||"",timestamp:new Date().toISOString()};
  db.auditTrail.push(a);persistOrThrow();return out(r,201,a)
});
if(q.method==="GET"&&p==="/api/governance/audit")return out(r,200,db.auditTrail||[]);
if(q.method==="GET"&&p==="/api/governance/status")return out(r,200,{controls:["allowlist de fontes","evidência pendente","quality gates","Red Team","revisão humana","audit trail"],principle:"automação não equivale a autorização jurídica"});
if(q.method==="POST"&&p==="/api/knowledge/entity")return body(q).then(x=>{
  db.knowledgeEntities=db.knowledgeEntities||[];const e={id:id("ke"),type:x.type||"concept",name:x.name||"",attrs:x.attrs||{},createdAt:new Date().toISOString()};db.knowledgeEntities.push(e);persistOrThrow();return out(r,201,e)
});
if(q.method==="POST"&&p==="/api/knowledge/edge")return body(q).then(x=>{
  db.knowledgeEdges=db.knowledgeEdges||[];const e={id:id("edge"),from:x.from,to:x.to,type:x.type||"supports",sourceId:x.sourceId||null,createdAt:new Date().toISOString()};db.knowledgeEdges.push(e);persistOrThrow();return out(r,201,e)
});
if(q.method==="GET"&&p==="/api/knowledge/graph")return out(r,200,{entities:db.knowledgeEntities||[],edges:db.knowledgeEdges||[]});
if(q.method==="POST"&&p==="/api/research/matrix")return body(q).then(x=>{
  const rows=(x.items||[]).map((v,i)=>({id:i+1,issue:v.issue||"",rule:v.rule||"",authority:v.authority||"",evidence:v.evidence||"",counterargument:v.counterargument||"",risk:v.risk||"medium",confidence:Number(v.confidence||0),status:"pending"}));
  return out(r,200,{matrix:rows,gates:["fonte primária","vigência","aderência fática","jurisprudência","contraditório","Red Team"],principle:"nenhuma conclusão sem lastro documental"})
});
if(q.method==="POST"&&p==="/api/workflow/task")return body(q).then(x=>{
  db.workflowTasks=db.workflowTasks||[];const t={id:id("wf"),title:x.title||"Tarefa",owner:x.owner||"Junta",priority:x.priority||"P2",dueAt:x.dueAt||null,status:"open",slaHours:Number(x.slaHours||24),createdAt:new Date().toISOString()};db.workflowTasks.push(t);persistOrThrow();return out(r,201,t)
});
if(q.method==="POST"&&p==="/api/workflow/escalate")return body(q).then(x=>{
  const t=(db.workflowTasks||[]).find(v=>v.id===x.taskId);if(!t)return out(r,404,{error:"task_not_found"});t.status="escalated";t.escalatedAt=new Date().toISOString();t.escalationReason=x.reason||"SLA";persistOrThrow();return out(r,200,t)
});
if(q.method==="GET"&&p==="/api/workflow/tasks")return out(r,200,visibleArray(db.workflowTasks));
if(q.method==="POST"&&p==="/api/portal/intake")return body(q).then(x=>{
  db.portalIntakes=db.portalIntakes||[];const i={id:id("pi"),clientId:x.clientId||null,subject:x.subject||"",message:x.message||"",documents:x.documents||[],status:"received",receivedAt:new Date().toISOString()};db.portalIntakes.push(i);persistOrThrow();return out(r,201,i)
});
if(q.method==="POST"&&p==="/api/portal/status")return body(q).then(x=>{
  const statuses=["received","triage","analysis","waiting_client","quality_review","delivered","closed"];if(!statuses.includes(x.status))return out(r,400,{error:"invalid_status"});
  const i=(db.portalIntakes||[]).find(v=>v.id===x.intakeId);if(!i)return out(r,404,{error:"intake_not_found"});i.status=x.status;i.updatedAt=new Date().toISOString();persistOrThrow();return out(r,200,i)
});
if(q.method==="GET"&&p==="/api/portal/intakes")return out(r,200,db.portalIntakes||[]);
if(q.method==="GET"&&p==="/api/analytics/kpis")return out(r,200,(()=>{
  const leads=visibleArray(db.crmLeads),contracts=visibleArray(db.contracts),tasks=visibleArray(db.workflowTasks),docs=visibleArray(db.factoryDocs),opps=visibleArray(db.opportunities);
  const won=contracts.length,openTasks=tasks.filter(t=>t.status==="open").length,approvedDocs=docs.filter(d=>d.status==="approved").length;
  return {leads:leads.length,contracts:won,openTasks,approvedDocs,opportunities:opps.length,mrr:contracts.reduce((a,c)=>a+Number(c.monthly||0),0),pipelineHealth:{leadToContract:leads.length?Math.round(won/leads.length*100):0,documentApproval:docs.length?Math.round(approvedDocs/docs.length*100):0,slaOpenTasks:openTasks}};
})());
if(q.method==="GET"&&p==="/api/agents/mesh/registry")return out(r,200,{agents:[
{id:"tributario",name:"Agente Tributário",domains:["ICMS","ICMS-ST","IBS","CBS","PIS","COFINS","planejamento"],requires:["fonte_primaria","vigencia"],output:"parecer_tecnico"},
{id:"contabil",name:"Agente Contábil",domains:["contabilidade","SPED","EFD","balanços","conciliação"],requires:["documentos_contabeis"],output:"diagnostico_contabil"},
{id:"auditoria",name:"Agente de Auditoria",domains:["auditoria","testes","evidencias","inconsistencias"],requires:["dados","evidencias"],output:"matriz_achados"},
{id:"juridico",name:"Agente Jurídico",domains:["direito","processo","petições","contratos"],requires:["fatos","fontes_primarias"],output:"analise_juridica"},
{id:"jurisprudencia",name:"Agente de Jurisprudência",domains:["STF","STJ","TRTs","precedentes","sumulas"],requires:["fonte_oficial"],output:"matriz_precedentes"},
{id:"legislacao",name:"Agente de Legislação",domains:["leis","decretos","portarias","normas"],requires:["fonte_oficial","vigencia"],output:"mapa_normativo"},
{id:"portugues",name:"Agente de Língua Portuguesa",domains:["português","redação","clareza","ABNT"],requires:["texto"],output:"revisao_textual"},
{id:"contencioso",name:"Agente de Contencioso",domains:["administrativo","judicial","defesa","recursos"],requires:["processo","evidencias"],output:"estrategia_contenciosa"},
{id:"redteam",name:"Agente Red Team",domains:["contraditorio","falhas","riscos","stress_test"],requires:["analise_completa"],output:"relatorio_redteam"},
{id:"comercial",name:"Agente Comercial",domains:["CRM","propostas","qualificacao","servicos"],requires:["perfil_cliente"],output:"proposta_oportunidade"},
{id:"financeiro",name:"Agente Financeiro",domains:["MRR","margem","precificacao","viabilidade"],requires:["dados_financeiros"],output:"analise_economica"},
{id:"atendimento",name:"Agente de Atendimento",domains:["triagem","cliente","portal","WhatsApp"],requires:["mensagem"],output:"triagem_cliente"}]});
if(q.method==="POST"&&p==="/api/agents/mesh/route")return body(q).then(x=>{
  const registry={tributario:["ICMS","ICMS-ST","IBS","CBS","PIS","COFINS","planejamento"],contabil:["contabilidade","SPED","EFD","balanços","conciliação"],auditoria:["auditoria","testes","evidencias","inconsistencias"],juridico:["direito","processo","petições","contratos"],jurisprudencia:["STF","STJ","TRTs","precedentes","sumulas"],legislacao:["leis","decretos","portarias","normas"],portugues:["português","redação","clareza","ABNT"],contencioso:["administrativo","judicial","defesa","recursos"],redteam:["contraditorio","falhas","riscos","stress_test"],comercial:["CRM","propostas","qualificacao","servicos"],financeiro:["MRR","margem","precificacao","viabilidade"],atendimento:["triagem","cliente","portal","WhatsApp"]};
  const text=String(x.text||"").toLowerCase(),scores=Object.entries(registry).map(([id,terms])=>({id,score:terms.reduce((n,t)=>n+(text.includes(t.toLowerCase())?1:0),0)})).filter(a=>a.score>0).sort((a,b)=>b.score-a.score);
  return out(r,200,{route:scores.slice(0,6),orchestration:"Junta Autônoma",parallel:true,redTeam:scores.some(a=>a.id==="juridico"||a.id==="tributario")});
});
if(q.method==="POST"&&p==="/api/agents/mesh/dispatch")return body(q).then(async x=>{
  const requested=Array.isArray(x.agents)?x.agents:[];
  const payload=x.payload&&typeof x.payload==="object"?x.payload:{};
  const inputText=String(payload.text||payload.task||payload.prompt||"Status operacional JARVIS").trim();
  const inputHash=crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const job={id:id("mesh"),orchestrator:"Junta Autônoma",status:"executing",executionMode:"agent_hub",specialistExecutionProven:false,parallel:true,createdAt:new Date().toISOString(),inputHash,runs:[]};
  db.agentRuns=db.agentRuns||[];db.agentRuns.push(job);persistOrThrow();
  // Despacho paralelo é delegado a uma única chamada ao contrato /specialists/execute.
  // Isso evita N chamadas concorrentes ao /chat do Hub, que podem disputar o mesmo
  // mecanismo de inferência/estado, mantendo paralelismo dentro do próprio Hub.
  const started=Date.now();
  let results=[];
  try{
    const c=new AbortController();const t=setTimeout(()=>c.abort(),Number(process.env.AGENT_HUB_TIMEOUT_MS||120000));
    const resp=await fetch("http://127.0.0.1:8520/specialists/execute",{method:"POST",headers:{"Content-Type":"application/json","X-JARVIS-ORIGIN":"ravel360-mesh"},body:JSON.stringify({text:inputText,specialists:requested}),signal:c.signal});
    clearTimeout(t);
    const data=await resp.json();
    const returned=Array.isArray(data.results)?data.results:[];
    results=requested.map(agent=>{
      const result=returned.find(v=>String(v.id||v.agent)===String(agent));
      const requiresHumanReview=["juridico","tributario","contencioso","redteam"].includes(agent);
      return result?{agent,status:resp.ok&&data.ok!==false&&result.status!=="ERROR"?"completed":"failed",hubHttpStatus:resp.status,elapsedMs:Date.now()-started,requiresHumanReview,result}:{agent,status:"failed",hubHttpStatus:resp.status,elapsedMs:Date.now()-started,requiresHumanReview,error:"specialist_result_missing"};
    });
  }catch(e){
    results=requested.map(agent=>({agent,status:"failed",hubHttpStatus:null,elapsedMs:Date.now()-started,requiresHumanReview:["juridico","tributario","contencioso","redteam"].includes(agent),error:String(e)}));
  }
  job.runs=results;job.completedAt=new Date().toISOString();job.status=results.length&&results.every(v=>v.status==="completed")?"completed":"completed_with_failures";job.specialistExecutionProven=results.length>0&&results.every(v=>v.status==="completed");
  persistOrThrow();return out(r,job.specialistExecutionProven?200:502,job);
});
if(q.method==="POST"&&p==="/api/agents/mesh/aggregate")return body(q).then(x=>{
  const results=x.results||[];const conflicts=results.filter(v=>v.conflict||v.confidence<60);const evidence=results.filter(v=>!(v.sources&&v.sources.length));
  return out(r,200,{status:conflicts.length||evidence.length?"needs_review":"ready_for_redteam",results,conflicts:conflicts.length,evidenceGaps:evidence.length,requiredNext:conflicts.length||evidence.length?["resolver conflitos","completar fontes","revisão humana"]:["Red Team","revisão humana","aprovação"]})
});
if(q.method==="GET"&&p==="/api/agents/mesh/runs")return out(r,200,db.agentRuns||[]);
if(q.method==="POST"&&p==="/api/agents/memory/write")return body(q).then(x=>{
 db.agentMemory=db.agentMemory||[];const m={id:id("am"),agent:x.agent||"junta",scope:x.scope||"global",key:x.key||"",value:x.value||null,confidence:Number(x.confidence||0),sourceIds:x.sourceIds||[],createdAt:new Date().toISOString()};db.agentMemory.push(m);persistOrThrow();return out(r,201,m)
});
if(q.method==="POST"&&p==="/api/agents/memory/query")return body(q).then(x=>out(r,200,(db.agentMemory||[]).filter(m=>(!x.agent||m.agent===x.agent)&&(!x.scope||m.scope===x.scope)&&(!x.key||m.key===x.key)).slice(-50)));
if(q.method==="GET"&&p==="/api/agents/tools/registry")return out(r,200,{tools:[
{id:"web_search",kind:"research",risk:"medium",requires:"source_policy"},
{id:"official_source_fetch",kind:"research",risk:"medium",requires:"allowlist"},
{id:"calculator",kind:"computation",risk:"low",requires:"none"},
{id:"document_factory",kind:"production",risk:"medium",requires:"quality_gates"},
{id:"crm",kind:"commercial",risk:"medium",requires:"human_approval"},
{id:"client_portal",kind:"client",risk:"medium",requires:"authenticated_context"},
{id:"legal_action",kind:"legal",risk:"high",requires:"human_approval"}]});
if(q.method==="POST"&&p==="/api/agents/tools/authorize")return body(q).then(x=>{
 const high=["legal_action","crm"];const approved=high.includes(x.tool)?x.humanApproved===true:true;return out(r,approved?200:403,{tool:x.tool,approved,reason:approved?"policy_pass":"human_approval_required"})
});
if(q.method==="POST"&&p==="/api/sources/policy/check")return body(q).then(x=>{
 let domain="",urlValid=false;try{const u=new URL(String(x.url||""));domain=u.hostname.toLowerCase();urlValid=u.protocol==="https:"}catch{}
 const claimed=String(x.domain||"").toLowerCase();const claimMatches=!claimed||claimed===domain;const allow=urlValid&&claimMatches&&validOfficialDomain(domain),official=allow;
 return out(r,200,{allowed:allow,official,allowlisted:allow,provenance:{url:x.url||"",domain,checkedAt:new Date().toISOString(),clientClaimIgnored:true,claimMatches,urlValid},next:allow?["capture evidence","record version","check vigency"]:["do not use as primary authority","find primary source"]})
});
if(q.method==="POST"&&p==="/api/cases/context")return body(q).then(x=>{
 db.caseContexts=db.caseContexts||[];const c={id:id("ctx"),caseId:x.caseId||"",clientId:x.clientId||"",facts:x.facts||[],issues:x.issues||[],documents:x.documents||[],deadlines:x.deadlines||[],constraints:x.constraints||[],createdAt:new Date().toISOString()};db.caseContexts.push(c);persistOrThrow();return out(r,201,c)
});
if(q.method==="GET"&&p==="/api/cases/context")return out(r,200,db.caseContexts||[]);
if(q.method==="POST"&&p==="/api/agents/bus/send")return body(q).then(x=>{
 db.agentMessages=db.agentMessages||[];const m={id:id("msg"),from:x.from||"junta",to:x.to||"junta",type:x.type||"finding",payload:x.payload||{},requiresResponse:!!x.requiresResponse,status:"sent",createdAt:new Date().toISOString()};db.agentMessages.push(m);persistOrThrow();return out(r,201,m)
});
if(q.method==="GET"&&p==="/api/agents/bus")return out(r,200,db.agentMessages||[]);
if(q.method==="POST"&&p==="/api/agents/consensus")return body(q).then(x=>{
 const rs=x.results||[];const valid=rs.filter(v=>Number(v.confidence||0)>=60);const avg=valid.length?Math.round(valid.reduce((a,v)=>a+Number(v.confidence||0),0)/valid.length):0;
 const positions=[...new Set(valid.map(v=>String(v.position||"")))].filter(Boolean);const conflict=positions.length>1;
 return out(r,200,{decision:valid.length>=2&&!conflict&&avg>=70?"consensus":"no_consensus",confidence:avg,participants:rs.length,valid:valid.length,conflict,positions,next:conflict?["adversarial_review","redteam","human_review"]:["redteam","human_review"]})
});
if(q.method==="POST"&&p==="/api/agents/redteam/run")return body(q).then(x=>{
 const claims=x.claims||[],sources=x.sources||[],counter=x.counterarguments||[],gaps=Math.max(0,claims.length-sources.length),issues=[];
 if(gaps)issues.push("claims_without_source");if(!counter.length)issues.push("counterargument_missing");if(x.vigencyChecked!==true)issues.push("vigency_not_verified");if(x.factualFit!==true)issues.push("factual_fit_not_verified");
 return out(r,200,{status:issues.length?"challenge":"passed",severity:issues.length>=2?"high":issues.length?"medium":"low",issues,gaps,required:["human_review"]})
});
if(q.method==="POST"&&p==="/api/agents/learning/outcome")return body(q).then(x=>{
 db.agentOutcomes=db.agentOutcomes||[];const o={id:id("out"),agent:x.agent||"",caseId:x.caseId||"",prediction:x.prediction||"",actual:x.actual||"",result:x.result||"unknown",lessons:x.lessons||[],createdAt:new Date().toISOString()};db.agentOutcomes.push(o);persistOrThrow();return out(r,201,o)
});
if(q.method==="GET"&&p==="/api/agents/learning/outcomes")return out(r,200,db.agentOutcomes||[]);
if(q.method==="POST"&&p==="/api/growth/opportunity")return body(q).then(x=>{
 db.growthOpportunities=db.growthOpportunities||[];const fit=Number(x.fit||0),urgency=Number(x.urgency||0),value=Number(x.value||0);
 const score=Math.round(fit*.35+urgency*.25+value*.40);const action=score>=80?"proposta_prioritaria":score>=60?"diagnostico_comercial":"nutricao";
 const o={id:id("go"),clientId:x.clientId||"",trigger:x.trigger||"",score,action,status:"open",createdAt:new Date().toISOString()};db.growthOpportunities.push(o);persistOrThrow();return out(r,201,o)
});
if(q.method==="GET"&&p==="/api/growth/opportunities")return out(r,200,db.growthOpportunities||[]);
if(q.method==="GET"&&p==="/api/control-plane/status")return out(r,200,(()=>{
 const counts={memory:(db.agentMemory||[]).length,messages:(db.agentMessages||[]).length,outcomes:(db.agentOutcomes||[]).length,growth:(db.growthOpportunities||[]).length,contexts:(db.caseContexts||[]).length};
 return {version:"v32",controlPlane:"operational",counts,controls:["agent registry","tool permissions","source provenance","case context","message bus","consensus","red team","learning","growth automation","audit trail"],humanApproval:["legal_action","commercial_write","final_legal_conclusion"]};
})());
if(q.method==="POST"&&p==="/api/commercial/service")return body(q).then(x=>{
 db.services=db.services||[];const s={id:id("svc"),name:x.name||"",area:x.area||"",model:x.model||"project",price:Number(x.price||0),recurring:Number(x.recurring||0),sla:x.sla||"",active:true,createdAt:new Date().toISOString()};db.services.push(s);persistOrThrow();return out(r,201,s)
});
if(q.method==="POST"&&p==="/api/commercial/proposal")return body(q).then(x=>{
 db.proposals=db.proposals||[];const s=(db.services||[]).find(v=>v.id===x.serviceId);const p={id:id("prop"),clientId:x.clientId||"",serviceId:x.serviceId||null,serviceName:s?.name||x.serviceName||"",setup:Number(x.setup||s?.price||0),monthly:Number(x.monthly||s?.recurring||0),validDays:Number(x.validDays||10),status:"draft",createdAt:new Date().toISOString()};db.proposals.push(p);persistOrThrow();return out(r,201,p)
});
if(q.method==="GET"&&p==="/api/commercial/services")return out(r,200,db.services||[]);
if(q.method==="GET"&&p==="/api/commercial/proposals")return out(r,200,db.proposals||[]);
if(q.method==="POST"&&p==="/api/billing/contract")return body(q).then(x=>{
 db.billingContracts=db.billingContracts||[];const c={id:id("bc"),clientId:x.clientId||"",proposalId:x.proposalId||null,setup:Number(x.setup||0),monthly:Number(x.monthly||0),billingDay:Number(x.billingDay||10),status:"active",startedAt:new Date().toISOString()};db.billingContracts.push(c);persistOrThrow();return out(r,201,c)
});
if(q.method==="POST"&&p==="/api/billing/invoice")return body(q).then(x=>{
 db.invoices=db.invoices||[];const i={id:id("inv"),contractId:x.contractId||"",amount:Number(x.amount||0),dueAt:x.dueAt||null,status:"issued",issuedAt:new Date().toISOString()};db.invoices.push(i);persistOrThrow();return out(r,201,i)
});
if(q.method==="GET"&&p==="/api/billing/dashboard")return out(r,200,(()=>{const cs=db.billingContracts||[],is=db.invoices||[];return {activeContracts:cs.filter(c=>c.status==="active").length,mrr:cs.reduce((a,c)=>a+c.monthly,0),issued:is.filter(i=>i.status==="issued").length,receivables:is.filter(i=>i.status==="issued").reduce((a,i)=>a+i.amount,0)}})());
if(q.method==="POST"&&p==="/api/evidence/register")return body(q).then(x=>{
 db.evidenceVault=db.evidenceVault||[];const e={id:id("ev"),caseId:x.caseId||"",name:x.name||"",type:x.type||"document",sha256:x.sha256||"",source:x.source||"",confidentiality:x.confidentiality||"restricted",retentionUntil:x.retentionUntil||null,verified:false,createdAt:new Date().toISOString()};db.evidenceVault.push(e);persistOrThrow();return out(r,201,e)
});
if(q.method==="POST"&&p==="/api/evidence/verify")return body(q).then(x=>{
 const e=(db.evidenceVault||[]).find(v=>v.id===x.id);if(!e)return out(r,404,{error:"evidence_not_found"});e.verified=x.verified===true;e.verifiedBy=x.verifiedBy||"human";e.verifiedAt=new Date().toISOString();persistOrThrow();return out(r,200,e)
});
if(q.method==="GET"&&p==="/api/evidence/case")return out(r,200,(db.evidenceVault||[]).filter(e=>!q.query?.caseId||e.caseId===q.query.caseId));
const OFFICIAL_ADAPTERS={
 planalto:{id:"planalto",name:"Planalto",type:"legislation",mode:"official_portal_fetch",base:"https://www.planalto.gov.br",url:"https://www4.planalto.gov.br/legislacao/"},
 stf:{id:"stf",name:"STF",type:"jurisprudence",mode:"official_portal_fetch",base:"https://portal.stf.jus.br",url:"https://portal.stf.jus.br/jurisprudencia/"},
 stj:{id:"stj",name:"STJ",type:"jurisprudence",mode:"official_portal_fetch",base:"https://scon.stj.jus.br",url:"https://scon.stj.jus.br/SCON/"},
 trt7:{id:"trt7",name:"TRT-7",type:"labor",mode:"official_portal_fetch",base:"https://www.trt7.jus.br",url:"https://pje.trt7.jus.br/jurisprudencia/"},
 sefazce:{id:"sefazce",name:"SEFAZ/CE",type:"tax",mode:"official_portal_fetch",base:"https://sefazlegis.sefaz.ce.gov.br",url:"https://sefazlegis.sefaz.ce.gov.br/"}
};
async function fetchOfficialAdapter(id){
 const a=OFFICIAL_ADAPTERS[id];if(!a)throw Object.assign(new Error("unknown_adapter"),{code:"UNKNOWN_ADAPTER"});
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Number(process.env.SOURCE_FETCH_TIMEOUT_MS||15000));
 try{
   const resp=await fetch(a.url,{redirect:"manual",signal:controller.signal,headers:{"User-Agent":"Ravel360-OfficialSourceAdapter/1.0","Accept":"text/html,application/xhtml+xml"}});
   if(resp.status>=300&&resp.status<400)throw Object.assign(new Error("redirect_blocked"),{code:"REDIRECT_BLOCKED",status:resp.status});
   if(!resp.ok)throw Object.assign(new Error("source_http_"+resp.status),{code:"SOURCE_HTTP",status:resp.status});
   const len=Number(resp.headers.get("content-length")||0);if(len>MAX_FETCH_RESPONSE_BYTES)throw Object.assign(new Error("source_too_large"),{code:"SOURCE_TOO_LARGE"});
   const reader=resp.body?.getReader();let total=0,chunks=[];
   if(reader){for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_FETCH_RESPONSE_BYTES)throw Object.assign(new Error("source_too_large"),{code:"SOURCE_TOO_LARGE"});chunks.push(value)}}
   const content=Buffer.concat(chunks.map(v=>Buffer.from(v))).toString("utf8");
   return {id:a.id,name:a.name,type:a.type,url:a.url,status:resp.status,bytes:total,contentSha256:crypto.createHash("sha256").update(content).digest("hex"),accessedAt:new Date().toISOString(),mode:a.mode};
 }finally{clearTimeout(timer)}
}
if(q.method==="GET"&&p==="/api/sources/adapters")return out(r,200,{adapters:Object.values(OFFICIAL_ADAPTERS).map(a=>({...a,requires:a.type==="jurisprudence"?["query","date"]:["query_or_document"],officialDomain:true}))});
if(q.method==="POST"&&p==="/api/sources/verify")return body(q).then(async x=>{
 const ids=x.adapters?.length?x.adapters:Object.keys(OFFICIAL_ADAPTERS),results=[];
 for(const aid of ids){try{results.push({ok:true,...await fetchOfficialAdapter(aid)})}catch(e){results.push({ok:false,id:aid,error:e.code||"fetch_failed",message:e.message,status:e.status||null})}}
 return out(r,results.every(v=>v.ok)?200:207,{checkedAt:new Date().toISOString(),results,allOfficial:results.every(v=>v.ok),policy:"primary_source_required"});
});
if(q.method==="POST"&&p==="/api/sources/refresh")return body(q).then(x=>{
 db.sourceRefreshes=db.sourceRefreshes||[];const a={id:id("sr"),adapter:x.adapter||"",query:x.query||"",status:"queued",requestedAt:new Date().toISOString(),policy:"primary_source_required"};db.sourceRefreshes.push(a);persistOrThrow();return out(r,202,a)
});
if(q.method==="POST"&&p==="/api/whatsapp/session")return body(q).then(x=>{
 db.whatsappSessions=db.whatsappSessions||[];const s={id:id("wa"),phoneHash:x.phoneHash||"",leadId:x.leadId||null,state:"triage",lastMessage:x.message||"",consent:x.consent===true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};db.whatsappSessions.push(s);persistOrThrow();return out(r,201,s)
});
if(q.method==="POST"&&p==="/api/whatsapp/transition")return body(q).then(x=>{
 const states=["triage","qualification","documents","proposal","human_review","closed"];const s=(db.whatsappSessions||[]).find(v=>v.id===x.id);if(!s)return out(r,404,{error:"session_not_found"});if(!states.includes(x.state))return out(r,400,{error:"invalid_state"});s.state=x.state;s.updatedAt=new Date().toISOString();persistOrThrow();return out(r,200,s)
});
if(q.method==="POST"&&p==="/api/privacy/consent")return body(q).then(x=>{
 db.privacyConsents=db.privacyConsents||[];const c={id:id("cons"),subjectId:x.subjectId||"",purpose:x.purpose||"",basis:x.basis||"consent",granted:x.granted===true,version:x.version||"1.0",timestamp:new Date().toISOString()};db.privacyConsents.push(c);persistOrThrow();return out(r,201,c)
});
if(q.method==="GET"&&p==="/api/privacy/consent")return out(r,200,(db.privacyConsents||[]).filter(c=>!q.query?.subjectId||c.subjectId===q.query.subjectId));
if(q.method==="POST"&&p==="/api/security/role"){
  const adminKey=String(process.env.RAVEL_ADMIN_API_KEY||"");
  const supplied=Buffer.from(String(q.headers["x-admin-api-key"]||"")),wanted=Buffer.from(adminKey);
  if(!adminKey||supplied.length!==wanted.length||!crypto.timingSafeEqual(supplied,wanted))return out(r,403,{error:"admin_authorization_required"});
  q.authContext={...identityForAdminKey(String(q.headers["x-admin-api-key"]||"")),authMethod:"admin_api_key"};
  return body(q).then(x=>{
    db.securityRoles=db.securityRoles||[];const role={id:id("role"),name:String(x.name||""),permissions:Array.isArray(x.permissions)?x.permissions.map(String).slice(0,100):[],scope:String(x.scope||q.authContext?.tenantId||"tenant"),tenantId:q.authContext?.tenantId||"system",createdBy:q.authContext?.principalId||"admin:ravel",createdAt:new Date().toISOString()};
    if(!role.name||role.name.length>100||role.permissions.length>100)return out(r,400,{error:"invalid_role"});
    db.securityRoles.push(role);persistOrThrow();return out(r,201,role)
  });
}
if(q.method==="POST"&&p==="/api/security/check")return body(q).then(x=>{
 const roles=db.securityRoles||[],requestedRole=String(x.role||""),r0=roles.find(v=>v.name===requestedRole);
 const principalRoles=q.authContext?.roles||[];
 const roleMembership=principalRoles.includes(requestedRole)||(q.authContext?.roles||[]).includes("security_admin");
 const tenantMatch=!r0||!r0.scope||r0.scope==="system"||r0.scope===q.authContext?.tenantId||r0.scope==="tenant";
 const allowed=!!r0&&roleMembership&&tenantMatch&&r0.permissions.includes(String(x.permission||""));
 return out(r,allowed?200:403,{allowed,role:requestedRole,permission:x.permission||"",scope:r0?.scope||x.scope||"tenant",principalId:q.authContext?.principalId||null,tenantId:q.authContext?.tenantId||null,reason:allowed?"permission_granted":"permission_denied"})
});
if(q.method==="POST"&&p==="/api/observability/event")return body(q).then(x=>{
 db.observability=db.observability||[];const e={id:id("obs"),service:x.service||"",event:x.event||"",severity:x.severity||"info",durationMs:Number(x.durationMs||0),traceId:x.traceId||id("trace"),createdAt:new Date().toISOString()};db.observability.push(e);persistOrThrow();return out(r,201,e)
});
if(q.method==="GET"&&p==="/api/observability/summary")return out(r,200,(()=>{const a=db.observability||[];return {events:a.length,errors:a.filter(e=>e.severity==="error").length,warnings:a.filter(e=>e.severity==="warn").length,avgDurationMs:a.length?Math.round(a.reduce((s,e)=>s+e.durationMs,0)/a.length):0,services:[...new Set(a.map(e=>e.service).filter(Boolean))]}})());
if(q.method==="GET"&&p==="/api/release/readiness")return out(r,200,(()=>{
 const checks=[
  {id:"syntax",label:"Node syntax",ok:true},
  {id:"regression",label:"Full regression suite",ok:regressionVerified()},
  {id:"human_gate",label:"Human approval gates",ok:true},
  {id:"source_policy",label:"Primary source policy",ok:true},
  {id:"browser",label:"Browser verification",ok:fs.existsSync(path.join(DATA,"browser-verification.json"))},
  {id:"secrets",label:"Production secrets",ok:Boolean(String(process.env.RAVEL_API_KEY||"").length>=32&&COOKIE_SECURE&&(PERSISTENCE_BACKEND==="sqlite"||process.env.DATABASE_URL))}
 ];return {status:checks.every(c=>c.ok)?"ready":"not_ready",checks,blocking:checks.filter(c=>!c.ok).map(c=>c.id),note:"Production deployment requires real credentials and external connector configuration."}
})());
if(q.method==="GET"&&p==="/api/company/command")return out(r,200,(()=>{
 const k=visibleArray(db.billingContracts),l=visibleArray(db.crmLeads),p=visibleArray(db.proposals),g=visibleArray(db.growthOpportunities),t=visibleArray(db.workflowTasks),c=visibleArray(db.caseContexts);
 return {company:"Ravel 360",operatingSystem:"v50",commercial:{leads:l.length,proposals:p.length,activeContracts:k.filter(x=>x.status==="active").length,mrr:k.reduce((a,x)=>a+x.monthly,0),growthOpportunities:g.length},delivery:{cases:c.length,openTasks:t.filter(x=>x.status==="open").length},governance:{humanApprovalRequired:["legal_action","commercial_write","final_legal_conclusion"],primarySourceRequired:true,redTeamRequired:true},release:{productionCredentialsRequired:true}}
})());
if(q.method==="POST"&&p==="/api/revenue/lead/qualify")return body(q).then(x=>{
  const lead=(db.crmLeads||[]).find(v=>v.id===x.leadId);if(!lead)return out(r,404,{error:"lead_not_found"});
  const fit=Number(x.fit||0),urgency=Number(x.urgency||0),value=Number(x.value||0),clarity=Number(x.clarity||0);
  const score=Math.round(fit*.30+urgency*.20+value*.30+clarity*.20),tier=score>=80?"A":score>=60?"B":score>=40?"C":"D";
  lead.score=score;lead.tier=tier;lead.stage=tier==="A"?"qualified_priority":tier==="B"?"qualified":"nurture";lead.qualifiedAt=new Date().toISOString();lead.nextAction=tier==="A"?"human_contact_and_diagnostic":tier==="B"?"qualification_followup":"educational_nurture";persistOrThrow();
  return out(r,200,{lead,route:tier==="A"?["Junta","Comercial","Especialista"]:tier==="B"?["Comercial","Especialista"]:["Nutrição"],humanApprovalRequired:false})
});
if(q.method==="POST"&&p==="/api/revenue/proposal/from-lead")return body(q).then(x=>{
  const lead=(db.crmLeads||[]).find(v=>v.id===x.leadId);if(!lead)return out(r,404,{error:"lead_not_found"});
  const svc=(db.services||[]).find(v=>v.id===x.serviceId);if(!svc)return out(r,404,{error:"service_not_found"});
  if(lead.tier!=="A"&&lead.tier!=="B")return out(r,409,{error:"lead_not_qualified",requiredTiers:["A","B"]});
  db.proposals=db.proposals||[];const proposal={id:id("prop"),leadId:lead.id,clientId:x.clientId||null,serviceId:svc.id,serviceName:svc.name,setup:Number(x.setup??svc.price??0),monthly:Number(x.monthly??svc.recurring??0),validDays:Number(x.validDays||10),status:"draft",approvalRequired:true,createdAt:new Date().toISOString()};db.proposals.push(proposal);lead.stage="proposal_draft";lead.nextAction="human_review_before_send";persistOrThrow();return out(r,201,{proposal,humanApprovalRequired:true,next:["review_scope","review_price","approve_send"]})
});
if(q.method==="POST"&&p==="/api/revenue/followup")return body(q).then(x=>{
  const lead=(db.crmLeads||[]).find(v=>v.id===x.leadId);if(!lead)return out(r,404,{error:"lead_not_found"});
  db.workflowTasks=db.workflowTasks||[];const t={id:id("wf"),title:`Follow-up comercial: ${lead.company||lead.name}`,owner:"Comercial",priority:lead.tier==="A"?"P1":"P2",status:"open",slaHours:Number(x.slaHours||24),leadId:lead.id,reason:x.reason||"Próximo passo comercial",createdAt:new Date().toISOString()};db.workflowTasks.push(t);lead.nextAction="followup_scheduled";lead.lastFollowupAt=new Date().toISOString();persistOrThrow();return out(r,201,{task:t,lead})
});
if(q.method==="GET"&&p==="/api/revenue/funnel")return out(r,200,(()=>{
 const leads=visibleArray(db.crmLeads),props=visibleArray(db.proposals),contracts=[...visibleArray(db.contracts),...visibleArray(db.billingContracts)],eng=visibleArray(db.engagements);
 const count=(pred)=>leads.filter(pred).length;const qualified=count(l=>l.tier==="A"||l.tier==="B"),proposalLead=new Set(props.map(p=>p.leadId).filter(Boolean)).size,recurring=contracts.filter(c=>Number(c.monthly||0)>0&&c.status!=="cancelled").length;
 return {stages:{leads:leads.length,qualified,proposals:props.length,proposalLeads:proposalLead,contracts:contracts.length,recurring,engagements:eng.length},conversion:{qualification:leads.length?Math.round(qualified/leads.length*100):0,proposalFromQualified:qualified?Math.round(proposalLead/qualified*100):0,recurringFromContracts:contracts.length?Math.round(recurring/contracts.length*100):0},channels:[...new Set(leads.map(l=>l.channel||l.origin||"unknown"))]}
})());
if(q.method==="GET"&&p==="/api/revenue/retention")return out(r,200,(()=>{
 const cs=[...visibleArray(db.contracts),...visibleArray(db.billingContracts)],eng=visibleArray(db.engagements),tasks=visibleArray(db.workflowTasks);
 const active=cs.filter(c=>c.status==="active"),atRisk=eng.filter(e=>["waiting_client","blocked","at_risk"].includes(e.stage)||tasks.some(t=>t.clientId===e.clientId&&t.status==="escalated"));
 return {activeClients:active.length,recurringClients:active.filter(c=>Number(c.monthly||0)>0).length,atRiskEngagements:atRisk.length,openDeliveryTasks:tasks.filter(t=>t.status==="open").length,signals:[atRisk.length?"followup_at_risk":"no_at_risk_signal","review_delivery_sla","measure_expansion"]}
})());
if(q.method==="POST"&&p==="/api/revenue/next-best-action")return body(q).then(x=>{
 const lead=(db.crmLeads||[]).find(v=>v.id===x.leadId);if(!lead)return out(r,404,{error:"lead_not_found"});
 const action=lead.tier==="A"?"schedule_diagnostic":lead.tier==="B"?"send_qualification_followup":lead.tier==="C"?"request_missing_context":"educational_nurture";
 return out(r,200,{leadId:lead.id,tier:lead.tier||"unqualified",action,reason:lead.tier==="A"?"high commercial priority":lead.tier==="B"?"qualified but needs progression":lead.tier==="C"?"insufficient clarity":"not yet qualified",humanApprovalRequired:action==="schedule_diagnostic"})
});
if(q.method==="POST"&&p==="/api/site/lead")return body(q).then(x=>{
 db.crmLeads=db.crmLeads||[];const lead={id:id("lead"),channel:"site",name:x.name||"",contact:x.contact||"",company:x.company||"",message:x.problem||x.message||"",intent:x.intent||"consultoria",status:"new",stage:"Novo",createdAt:new Date().toISOString()};db.crmLeads.push(lead);persistOrThrow();
 db.workflowTasks=db.workflowTasks||[];db.workflowTasks.push({id:id("wf"),title:`Triagem de lead: ${lead.company||lead.name}`,owner:"Atendimento + Comercial",priority:"P2",status:"open",slaHours:24,leadId:lead.id,createdAt:new Date().toISOString()});persistOrThrow();return out(r,201,{accepted:true,leadId:lead.id,next:["qualificar","rotear","followup"]})
});
if(q.method==="GET"&&p==="/api/revenue/dashboard")return out(r,200,(()=>{
 const leads=visibleArray(db.crmLeads),props=visibleArray(db.proposals),contracts=[...visibleArray(db.contracts),...visibleArray(db.billingContracts)],tasks=visibleArray(db.workflowTasks),services=visibleArray(db.services);
 const mrr=contracts.reduce((a,c)=>a+Number(c.monthly||0),0),oneoff=contracts.reduce((a,c)=>a+Number(c.setup||0),0),open=tasks.filter(t=>t.status==="open").length;
 return {actual:{leads:leads.length,qualified:leads.filter(l=>["A","B"].includes(l.tier)).length,proposals:props.length,activeContracts:contracts.filter(c=>c.status==="active").length,mrr,oneoffRevenueRecorded:oneoff,openTasks:open,serviceCatalog:services.length},targetsAreNotData:true,governance:{externalSendRequiresHumanApproval:true,legalConclusionRequiresHumanReview:true,primarySourceRequired:true}}
})());
// PRESERVED_LEGACY_ROUTES_20260905
if(q.method==="GET"&&p==="/api/junta/ten-areas")return out(r,200,{release:"v70",areas:10,implemented:10,production:{verified:false,blockers:["vercel_project_unavailable","external_deployment_not_verified"]},security:{credentialPersisted:false,rotationRequired:true}});
if(q.method==="POST"&&p==="/api/revenue/onboarding")return body(q).then(x=>{db.onboardings=db.onboardings||[];const c=(db.billingContracts||[]).find(v=>v.id===x.contractId);if(!c)return out(r,404,{error:"contract_not_found"});const o={id:id("onb"),clientId:x.clientId||c.clientId,contractId:c.id,owner:x.owner||"junta",checklist:[{key:"scope",status:x.scope?"complete":"pending"},{key:"documents",status:x.documents?"complete":"pending"},{key:"deadline",status:x.deadline?"complete":"pending"},{key:"responsible",status:x.responsible?"complete":"pending"},{key:"approval",status:x.approval===true?"complete":"pending"}],status:"ready_for_production",createdAt:new Date().toISOString()};o.blocked=o.checklist.some(v=>v.status==="pending");db.onboardings.push(o);persistOrThrow();return out(r,201,o)});
if(q.method==="POST"&&p==="/api/delivery/engagement")return body(q).then(x=>{db.deliveryEngagements=db.deliveryEngagements||[];const e={id:id("del"),clientId:x.clientId||"",contractId:x.contractId||"",service:x.service||"",dueAt:x.dueAt||null,owner:x.owner||"",status:"open",priority:x.priority||"normal",createdAt:new Date().toISOString()};db.deliveryEngagements.push(e);persistOrThrow();return out(r,201,e)});
if(q.method==="GET"&&p==="/api/delivery/capacity")return out(r,200,(()=>{const a=db.deliveryEngagements||[],now=Date.now();return {open:a.filter(e=>e.status==="open").length,overdue:a.filter(e=>e.status==="open"&&e.dueAt&&Date.parse(e.dueAt)<now).length,byOwner:a.reduce((m,e)=>(m[e.owner||"unassigned"]=(m[e.owner||"unassigned"]||0)+1,m),{})}})());
if(q.method==="POST"&&p==="/api/billing/collection-review")return body(q).then(x=>{const i=(db.invoices||[]).find(v=>v.id===x.invoiceId);if(!i)return out(r,404,{error:"invoice_not_found"});const age=i.dueAt?Math.max(0,Math.floor((Date.now()-Date.parse(i.dueAt))/86400000)):0,action=i.status==="paid"?"none":age>=15?"human_review_priority":age>0?"followup_draft":"monitor",item={invoiceId:i.id,ageDays:age,action,externalSendRequiresHuman:true,generatedAt:new Date().toISOString()};db.collectionReviews=db.collectionReviews||[];db.collectionReviews.push(item);persistOrThrow();return out(r,200,item)});
if(q.method==="GET"&&p==="/api/revenue/retention/playbook")return out(r,200,{rules:[{signal:"overdue_delivery",priority:"high",actions:["owner_review","replan_deadline","client_update_draft"]},{signal:"invoice_overdue",priority:"high",actions:["finance_review","followup_draft"]},{signal:"low_engagement",priority:"medium",actions:["check_in","value_review"]},{signal:"recurring_active",priority:"low",actions:["renewal_review","expansion_scan"]}],externalCommunication:"draft_only_until_human_approval"});
if(q.method==="GET"&&p==="/api/revenue/attribution")return out(r,200,(()=>{const ls=db.crmLeads||[],ps=db.proposals||[],cs=db.billingContracts||[],by={};for(const l of ls){const ch=l.channel||l.source||"unknown";by[ch]=by[ch]||{leads:0,qualified:0,proposals:0,contracts:0,mrr:0};by[ch].leads++;if(Number(l.score||0)>=60)by[ch].qualified++}for(const p0 of ps){const lead=ls.find(l=>l.id===p0.leadId),ch=lead?.channel||lead?.source||"unknown";by[ch]=by[ch]||{leads:0,qualified:0,proposals:0,contracts:0,mrr:0};by[ch].proposals++}for(const c of cs){const lead=ls.find(l=>l.id===c.leadId),ch=lead?.channel||lead?.source||"unknown";by[ch]=by[ch]||{leads:0,qualified:0,proposals:0,contracts:0,mrr:0};by[ch].contracts++;by[ch].mrr+=Number(c.monthly||0)}return {channels:by,principle:"only persisted source/channel fields; unknown remains unknown"}})());
if(q.method==="POST"&&p==="/api/governance/transition")return body(q).then(x=>{const allowed=["proposal_send","contract_activate","legal_conclusion","external_message","invoice_issue"];if(!allowed.includes(x.action))return out(r,400,{error:"invalid_action"});if(x.humanApproved!==true)return out(r,403,{error:"human_approval_required",action:x.action});db.auditTrail=db.auditTrail||[];const a={id:id("audit"),action:x.action,actor:x.actor||"human",entityId:x.entityId||"",reason:x.reason||"",timestamp:new Date().toISOString()};db.auditTrail.push(a);persistOrThrow();return out(r,200,{approved:true,audit:a})});
if(q.method==="GET"&&p==="/api/company/scorecard")return out(r,200,(()=>{const l=visibleArray(db.crmLeads),p0=visibleArray(db.proposals),c=visibleArray(db.billingContracts),d=visibleArray(db.deliveryEngagements),i=visibleArray(db.invoices),o=visibleArray(db.onboardings);return {acquisition:{leads:l.length,qualified:l.filter(x=>Number(x.score||0)>=60).length},sales:{proposals:p0.length,activeContracts:c.filter(x=>x.status==="active").length},recurring:{mrr:c.filter(x=>x.status==="active").reduce((a,x)=>a+Number(x.monthly||0),0)},delivery:{open:d.filter(x=>x.status==="open").length,overdue:d.filter(x=>x.status==="open"&&x.dueAt&&Date.parse(x.dueAt)<Date.now()).length},finance:{issued:i.filter(x=>x.status==="issued").length,receivables:i.filter(x=>x.status==="issued").reduce((a,x)=>a+Number(x.amount||0),0)},onboarding:{total:o.length,blocked:o.filter(x=>x.blocked).length},governance:{auditEvents:(db.auditTrail||[]).length,humanGates:true},dataQuality:{sourceUnknown:l.filter(x=>!(x.channel||x.source)).length,syntheticTargetsUsed:false}}})());
if(q.method==="GET"&&p==="/api/marketing/offers")return out(r,200,{offers:marketingOffers});
if(q.method==="GET"&&p==="/api/marketing/funnel")return out(r,200,{funnel:marketingFunnel,principles:["no fabricated testimonials","consent before outreach","technical content with source/date","human review for legal claims","LGPD by design"]});
if(q.method==="GET"&&p==="/api/marketing/content-calendar")return out(r,200,{cadence:"weekly",themes:["tributação","compliance","auditoria","contencioso","reforma tributária","gestão fiscal"],formats:["artigo","carrossel","vídeo curto","FAQ","case anonimizado"],approval:"human_before_publish"});
if(q.method==="POST"&&p==="/api/marketing/compliance-check")return body(q).then(x=>out(r,200,validateMarketingContent(x))).catch(()=>out(r,400,{error:"invalid_payload"}));
if(q.method==="POST"&&p==="/api/marketing/lead-capture")return body(q).then(x=>{const lead={id:"lead_"+Date.now().toString(36),name:String(x.name||"").slice(0,120),contact:String(x.contact||"").slice(0,180),interest:String(x.interest||"").slice(0,120),source:String(x.source||"direct").slice(0,80),campaign:String(x.campaign||"").slice(0,120),utm_source:String(x.utm_source||"").slice(0,80),utm_medium:String(x.utm_medium||"").slice(0,80),utm_campaign:String(x.utm_campaign||"").slice(0,120),consent:Boolean(x.consent),createdAt:new Date().toISOString(),status:"new"};if(!lead.consent)return out(r,400,{error:"consent_required"});db.crmLeads=db.crmLeads||[];db.crmLeads.push(lead);persistOrThrow();return out(r,201,{accepted:true,leadId:lead.id})}).catch(()=>out(r,400,{error:"invalid_payload"}));

if(q.method==="GET"&&p==="/api/health")return out(r,200,{ok:true,service:"ravel360-engine",layers:["ui","crm","cases","agents","workflows","research","dossiers","evidence","redteam","integrations","governance"]});
  if(q.method==="GET"&&p==="/api/health/ready")return (async()=>{
    if(!PRODUCTION)return out(r,200,{ok:true,service:"ravel360-engine",mode:"development",persistence:"local_json"});
    if(!productionStore?.pool)return out(r,503,{ok:false,service:"ravel360-engine",mode:"production",persistence:"unavailable"});
    try{await require(PERSISTENCE_BACKEND==="sqlite"?SQLITE_ADAPTER:POSTGRES_ADAPTER).healthcheck(productionStore.pool);return out(r,200,{ok:true,service:"ravel360-engine",mode:"production",persistence:PERSISTENCE_BACKEND})}
    catch(e){return out(r,503,{ok:false,service:"ravel360-engine",mode:"production",persistence:"unavailable",error:"database_unavailable"})}
  })();
  if(q.method==="GET"&&p==="/api/dashboard")return out(r,200,(()=>{
    const contracts=[...visibleArray(db.contracts),...visibleArray(db.billingContracts)];
    const mrr=contracts.reduce((n,c)=>n+Number(c.monthly??c.mrr??0),0);
    const pipeline=(db.proposals||[]).reduce((n,x)=>n+Number(x.monthly??x.value??x.price??0),0);
    const criticalRisks=(db.cases||[]).filter(c=>String(c.risk||"").toLowerCase()==="alto").length;
    return {mrr,pipeline,criticalRisks,agentsOnline:(db.agents||[]).length,leads:(db.leads||[]).length,cases:(db.cases||[]).length};
  })());
  if(q.method==="GET"&&p==="/api/agents")return out(r,200,db.agents.map(name=>({name,status:"online"})));
  if(q.method==="GET"&&p==="/api/cases")return out(r,200,visibleArray(db.cases));
  if(q.method==="GET"&&p==="/api/leads")return out(r,200,visibleArray(db.leads));
  if(q.method==="POST"&&p==="/api/leads")return body(q).then(x=>{let v={id:id("lead"),...x,stage:"Novo",createdAt:new Date().toISOString()};db.leads.push(v);persistOrThrow();return out(r,201,v)});
  if(q.method==="GET"&&p==="/api/metrics")return out(r,200,(()=>{
    const contracts=[...(db.contracts||[]),...(db.billingContracts||[])];
    const mrr=contracts.reduce((n,c)=>n+Number(c.monthly??c.mrr??0),0);
    const pipeline=(db.proposals||[]).reduce((n,x)=>n+Number(x.monthly??x.value??x.price??0),0);
    return {revenue:{mrr,pipeline},quality:{sourceDateRequired:true,redTeamRequired:true,humanReviewForCritical:true}};
  })());
  if(q.method==="GET"&&p==="/api/research/spec")return out(r,200,{module:"Núcleo de Pesquisa Aprofundada",version:"1.0",stages:["Cenário Zero","pergunta","decomposição","mapa de fontes","fontes primárias","legislação","jurisprudência","doutrina","dados","benchmarking","triangulação","evidências","Red Team","síntese","ação"],gates:["vigência","fonte primária","separação fato/interpretação","contraditório","evidência por afirmação","quantificação","revisão adversarial"]});
  if(q.method==="GET"&&p==="/api/research/pilot")return out(r,200,{title:"Pesquisa Aprofundada — Setor Gráfico / Piauí",status:"piloto estruturado",topics:["RICMS/PI","papel imune/RECOPI","ICMS/ISS","incentivos industriais","PRODEPI","crédito presumido","diferimento","SIEC","CODIN/SEFAZ","benchmarking","kit documental","SWOT"]});
  if(q.method==="POST"&&p==="/api/research/plan")return body(q).then(x=>out(r,200,{id:id("research"),status:"planned",question:x.question||"",agents:db.agents.slice(0,9),stages:["Cenário Zero","decomposição","mapa de fontes","pesquisa primária","triangulação","matriz de evidências","Red Team","relatório executivo"]}));
  if(q.method==="GET"&&p==="/api/research/dossier")return out(r,200,{schema:["identificação","Cenário Zero","questões","fontes","evidências","legislação/vigência","jurisprudência","doutrina","dados","benchmarking","Red Team","riscos","conclusões","recomendações","plano de ação"]});
  if(q.method==="POST"&&p==="/api/research/dossier")return body(q).then(x=>out(r,201,{id:id("dossier"),status:"created",title:x.title||"Pesquisa Aprofundada",sections:["Cenário Zero","Questões","Mapa de Fontes","Evidências","Análise","Contraditório","Red Team","Riscos","Conclusões","Plano de Ação"],evidenceRequired:true,createdAt:new Date().toISOString()}));
  if(q.method==="GET"&&p==="/api/integrations/status")return out(r,200,{connectors:[
   {id:"ai",name:"AI Gateway",status:process.env.AI_GATEWAY_API_KEY||process.env.VERCEL_OIDC_TOKEN?"declared_unverified":"ready_for_credentials"},
   {id:"whatsapp",name:"WhatsApp Business",status:process.env.WHATSAPP_ACCESS_TOKEN?"declared_unverified":"ready_for_credentials"},
   {id:"database",name:PERSISTENCE_BACKEND==="sqlite"?"SQLite":"Postgres",status:PRODUCTION?(productionStore?.pool?"verified":"unavailable"):(process.env.DATABASE_URL?"declared_unverified":"local_json_fallback")},
   {id:"crm",name:"CRM",status:process.env.CRM_API_KEY?"declared_unverified":"ready_for_credentials"},
   {id:"erp",name:"ERP/Contábil",status:process.env.ERP_API_URL?"declared_unverified":"ready_for_credentials"},
   {id:"storage",name:"Object Storage",status:process.env.STORAGE_ENDPOINT?"declared_unverified":"local_filesystem_fallback"}]});
  if(q.method==="POST"&&p==="/api/ai/route")return body(q).then(x=>out(r,200,{routed:true,providerConfigured:Boolean(process.env.AI_GATEWAY_API_KEY||process.env.VERCEL_OIDC_TOKEN),task:x.task||"general",policy:"Só chamar IA externa quando gateway estiver configurado.",next:["classify","retrieve evidence","reason","red-team","respond"]}));
  if(q.method==="POST"&&p==="/api/whatsapp/inbound")return body(q).then(x=>out(r,200,{received:true,channel:"whatsapp-adapter",status:"queued_for_triage",routing:["Comercial","Customer Success","Orquestrador Master"],messagePreview:String(x.message||"").slice(0,180)}));
  if(q.method==="POST"&&p==="/api/knowledge/query")return body(q).then(x=>out(r,200,{query:x.query,routing:["Tributário Master","Jurídico Master","Legislação","Jurisprudência","Red Team"],evidencePolicy:["FATO","FONTE","INTERPRETAÇÃO","HIPÓTESE","CONCLUSÃO","RECOMENDAÇÃO"]}));
  if(q.method==="POST"&&p==="/api/redteam")return body(q).then(x=>out(r,200,{claim:x.claim,verdict:"requires_review",attacks:["fonte primária?","vigência?","precedente contrário?","fato comprovado?","impacto quantificado?"]}));
  if(q.method==="POST"&&p==="/api/workflows/run")return body(q).then(x=>out(r,200,{id:id("run"),workflow:x.workflowId,status:"queued",steps:["Cenário Zero","decomposição","agentes","evidências","Red Team","consolidação","plano de ação"]}));
  if(q.method==="POST"&&p==="/api/evidence")return body(q).then(x=>{let v={id:id("ev"),...x,consultedAt:new Date().toISOString()};db.evidence.push(v);persistOrThrow();return out(r,201,v)});
  if(q.method!=="GET"&&q.method!=="HEAD")return out(r,405,{error:"method_not_allowed"});
  let f=p==="/"?"index.html":p.replace(/^\/+/,"");
  const publicRoot=path.resolve(PUBLIC), publicCandidate=path.resolve(PUBLIC,f), rootCandidate=path.resolve(ROOT,f);
  let fp=publicCandidate;
  if(!publicCandidate.startsWith(publicRoot+path.sep)&&publicCandidate!==publicRoot)return out(r,403,{error:"forbidden"});
  if(!fs.existsSync(fp)&&/^[A-Za-z0-9._-]+\.html$/.test(f)){
    if(rootCandidate!==ROOT&&rootCandidate.startsWith(path.resolve(ROOT)+path.sep))fp=rootCandidate;
  }
  fs.readFile(fp,(e,d)=>{if(e)return out(r,404,{error:"not_found"});let ext=path.extname(fp);let ct=ext===".html"?"text/html; charset=utf-8":ext===".js"?"text/javascript; charset=utf-8":"text/plain; charset=utf-8";r.writeHead(200,securityHeaders({"Content-Type":ct,"Content-Length":String(d.length),"Cache-Control":"no-store"}));if(q.method!=="HEAD")r.end(d);else r.end()});
 }catch(e){
   const code=e&&e.code;
   if(code==="INVALID_JSON")return out(r,400,{error:"invalid_json",message:"Request body must be valid JSON."});
   if(code==="REQUEST_BODY_TOO_LARGE")return out(r,413,{error:"request_body_too_large",message:"Request body exceeds the 1 MiB limit."});
   console.error("REQUEST_ERROR:",p,e&&e.message);
   return out(r,500,{error:"internal_error",message:"Internal server error."});
 }
}
const server=http.createServer((q,r)=>Promise.resolve(route(q,r)).catch(e=>{
  if(r.headersSent||r.destroyed)return;
  if(e&&e.code==="INVALID_JSON")return out(r,400,{error:"invalid_json",message:"Request body must be valid JSON."});
  if(e&&e.code==="REQUEST_BODY_TOO_LARGE")return out(r,413,{error:"request_body_too_large",message:"Request body exceeds the 1 MiB limit."});
  return out(r,500,{error:"internal_error",message:"Unhandled request error."});
}));
server.requestTimeout=Number(process.env.REQUEST_TIMEOUT_MS||30000);
server.headersTimeout=Number(process.env.HEADERS_TIMEOUT_MS||10000);
server.keepAliveTimeout=Number(process.env.KEEPALIVE_TIMEOUT_MS||5000);
server.maxHeadersCount=Number(process.env.MAX_HEADERS_COUNT||100);
const shutdown=signal=>{
 console.log("Ravel 360 shutting down: "+signal);
 Promise.resolve(flushProductionPersistence()).then(async()=>{
   if(productionStore?.pool){if(PERSISTENCE_BACKEND==="sqlite")require(SQLITE_ADAPTER).close(productionStore.pool);else await productionStore.pool.end().catch(e=>console.error("PG_POOL_CLOSE_ERROR:",e.message));}
   server.close(()=>process.exit(0));
 },async e=>{
   console.error("PERSISTENCE_FLUSH_ERROR:",e.message);
   if(productionStore?.pool)await productionStore.pool.end().catch(()=>{});
   process.exit(1);
 });
 setTimeout(()=>process.exit(1),5000).unref();
};
process.on("SIGTERM",()=>shutdown("SIGTERM"));process.on("SIGINT",()=>shutdown("SIGINT"));
server.on("error",e=>{if(e&&e.code==="EADDRINUSE"){console.error("Ravel 360 startup error: port already in use: "+PORT);process.exitCode=98}else{console.error("Ravel 360 startup error:",e);process.exitCode=1}});
async function boot(){
  if(PRODUCTION){
    const adapter=require(PERSISTENCE_BACKEND==="sqlite"?SQLITE_ADAPTER:POSTGRES_ADAPTER);
    productionStore=await adapter.initialize(PERSISTENCE_BACKEND==="sqlite"?SQLITE_FILE:process.env.DATABASE_URL,db);
    db={...db,...productionStore.state};
    persistenceDirty=false;
    persistenceVersion=productionStore.version;
    persistenceFailure=null;
    console.log("Ravel 360 production persistence: "+PERSISTENCE_BACKEND+" verified");
  }
  const host=String(process.env.RAVEL_BIND_HOST||(PRODUCTION?"0.0.0.0":"127.0.0.1"));
  server.listen(PORT,host,()=>console.log("Ravel 360 running on http://"+host+":"+PORT));
}
boot().catch(e=>{console.error("Ravel 360 startup failed:",e.message);process.exitCode=1});
